/**
 * Custom MCP tool: health summary for an Account.
 *
 * The invocable method is published as the `getAccountHealth` tool of the custom
 * Salesforce Hosted MCP server `Headless_Assistant_Tools`
 * (see mcpServerDefinitions/Headless_Assistant_Tools.mcpServerDefinition-meta.xml).
 *
 * Security: `with sharing` plus `WITH USER_MODE` on every query, so the signed-in
 * user's object permissions, field-level security and sharing rules all apply.
 * The class, method and request/result types are `global`, which the hosted MCP
 * tool discovery for Apex actions expects.
 */
global with sharing class AccountHealthTool {

    @TestVisible
    private static final Integer STALE_ACTIVITY_DAYS = 30;
    @TestVisible
    private static final Integer CLOSING_SOON_DAYS = 30;
    private static final Integer MAX_ROWS = 2000;

    @InvocableMethod(
        label='Get Account Health'
        description='Returns a health summary for an Account: open opportunities, open and probability-weighted pipeline, deals closing in the next 30 days, open and high-priority cases, days since the last activity, a 0-100 health score, a status (Healthy, Watch, At Risk) and a one-line summary. Provide accountId, or accountName when the Id is unknown (exact names win, otherwise a partial match is used).'
    )
    global static List<AccountHealthResult> getAccountHealth(List<AccountHealthRequest> requests) {
        List<AccountHealthResult> results = new List<AccountHealthResult>();
        if (requests == null || requests.isEmpty()) {
            return results;
        }

        try {
            List<Resolution> resolutions = resolveAccounts(requests);
            Set<Id> accountIds = new Set<Id>();
            for (Resolution resolution : resolutions) {
                if (resolution.matchedAccount != null) {
                    accountIds.add(resolution.matchedAccount.Id);
                }
            }
            Map<Id, Metrics> metricsByAccount = loadMetrics(accountIds);
            for (Integer i = 0; i < requests.size(); i++) {
                results.add(buildResult(requests[i], resolutions[i], metricsByAccount));
            }
        } catch (QueryException e) {
            // WITH USER_MODE throws when the caller lacks object or field access.
            results = failAll(requests.size(), 'Salesforce denied access to the data this tool reads: ' + e.getMessage());
        } catch (Exception e) {
            // Return the problem to the agent instead of failing the whole MCP tool call.
            results = failAll(requests.size(), 'Account health could not be calculated: ' + e.getMessage());
        }
        return results;
    }

    // ------------------------------------------------------------------
    // Account resolution
    // ------------------------------------------------------------------

    private class Resolution {
        public Account matchedAccount;
        public String matchType;
    }

    private static List<Resolution> resolveAccounts(List<AccountHealthRequest> requests) {
        Set<Id> ids = new Set<Id>();
        Set<String> names = new Set<String>();
        for (AccountHealthRequest request : requests) {
            if (request == null) {
                continue;
            }
            Id accountId = toAccountId(request.accountId);
            if (accountId != null) {
                ids.add(accountId);
            } else if (String.isNotBlank(request.accountName)) {
                names.add(request.accountName.trim());
            }
        }

        Map<Id, Account> byId = new Map<Id, Account>();
        Map<String, Account> byLowerName = new Map<String, Account>();
        if (!ids.isEmpty() || !names.isEmpty()) {
            for (Account acc : [
                SELECT Id, Name, Industry, Owner.Name, LastActivityDate
                FROM Account
                WHERE Id IN :ids OR Name IN :names
                WITH USER_MODE
                ORDER BY LastModifiedDate DESC
                LIMIT :MAX_ROWS
            ]) {
                byId.put(acc.Id, acc);
                String key = acc.Name.toLowerCase();
                if (!byLowerName.containsKey(key)) {
                    byLowerName.put(key, acc);
                }
            }
        }

        List<Resolution> resolutions = new List<Resolution>();
        for (AccountHealthRequest request : requests) {
            Resolution resolution = new Resolution();
            if (request != null) {
                Id accountId = toAccountId(request.accountId);
                if (accountId != null) {
                    resolution.matchedAccount = byId.get(accountId);
                    resolution.matchType = 'id';
                } else if (String.isNotBlank(request.accountName)) {
                    String name = request.accountName.trim();
                    resolution.matchedAccount = byLowerName.get(name.toLowerCase());
                    resolution.matchType = 'name';
                    if (resolution.matchedAccount == null) {
                        // Bounded by the number of requests; exact matches above need no query.
                        resolution.matchedAccount = findByPartialName(name);
                        resolution.matchType = 'partial';
                    }
                }
            }
            resolutions.add(resolution);
        }
        return resolutions;
    }

    private static Id toAccountId(String value) {
        if (String.isBlank(value)) {
            return null;
        }
        try {
            Id candidate = Id.valueOf(value.trim());
            return candidate.getSObjectType() == Account.SObjectType ? candidate : null;
        } catch (StringException e) {
            return null;
        }
    }

    private static Account findByPartialName(String name) {
        String pattern = '%' + escapeLike(name) + '%';
        List<Account> matches = [
            SELECT Id, Name, Industry, Owner.Name, LastActivityDate
            FROM Account
            WHERE Name LIKE :pattern
            WITH USER_MODE
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        return matches.isEmpty() ? null : matches[0];
    }

    private static String escapeLike(String value) {
        return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_');
    }

    // ------------------------------------------------------------------
    // Metrics (one query per object for all requested accounts)
    // ------------------------------------------------------------------

    private class Metrics {
        public Integer openOpportunityCount = 0;
        public Decimal openPipelineAmount = 0;
        public Decimal weightedPipelineAmount = 0;
        public Integer closingSoonCount = 0;
        public Date nextCloseDate;
        public Integer openCaseCount = 0;
        public Integer highPriorityCaseCount = 0;
        public Date lastClosedTaskDate;
    }

    private static Map<Id, Metrics> loadMetrics(Set<Id> accountIds) {
        Map<Id, Metrics> metricsById = new Map<Id, Metrics>();
        for (Id accountId : accountIds) {
            metricsById.put(accountId, new Metrics());
        }
        if (accountIds.isEmpty()) {
            return metricsById;
        }

        Date closingSoonLimit = Date.today().addDays(CLOSING_SOON_DAYS);
        for (Opportunity opp : [
            SELECT AccountId, Amount, Probability, CloseDate
            FROM Opportunity
            WHERE AccountId IN :accountIds AND IsClosed = false
            WITH USER_MODE
            LIMIT :MAX_ROWS
        ]) {
            Metrics m = metricsById.get(opp.AccountId);
            Decimal amount = opp.Amount == null ? 0 : opp.Amount;
            Decimal probability = opp.Probability == null ? 0 : opp.Probability;
            m.openOpportunityCount++;
            m.openPipelineAmount += amount;
            m.weightedPipelineAmount += amount * probability / 100;
            if (opp.CloseDate != null) {
                if (m.nextCloseDate == null || opp.CloseDate < m.nextCloseDate) {
                    m.nextCloseDate = opp.CloseDate;
                }
                if (opp.CloseDate <= closingSoonLimit) {
                    m.closingSoonCount++;
                }
            }
        }

        for (Case c : [
            SELECT AccountId, Priority
            FROM Case
            WHERE AccountId IN :accountIds AND IsClosed = false
            WITH USER_MODE
            LIMIT :MAX_ROWS
        ]) {
            Metrics m = metricsById.get(c.AccountId);
            m.openCaseCount++;
            if (c.Priority == 'High' || c.Priority == 'Critical') {
                m.highPriorityCaseCount++;
            }
        }

        for (Task t : [
            SELECT WhatId, ActivityDate
            FROM Task
            WHERE WhatId IN :accountIds AND IsClosed = true AND ActivityDate != null
            WITH USER_MODE
            ORDER BY ActivityDate DESC
            LIMIT :MAX_ROWS
        ]) {
            Metrics m = metricsById.get(t.WhatId);
            if (m != null && (m.lastClosedTaskDate == null || t.ActivityDate > m.lastClosedTaskDate)) {
                m.lastClosedTaskDate = t.ActivityDate;
            }
        }
        return metricsById;
    }

    // ------------------------------------------------------------------
    // Result building and scoring
    // ------------------------------------------------------------------

    private static AccountHealthResult buildResult(AccountHealthRequest request, Resolution resolution, Map<Id, Metrics> metricsByAccount) {
        AccountHealthResult result = new AccountHealthResult();
        if (resolution.matchedAccount == null) {
            result.found = false;
            result.message = notFoundMessage(request);
            return result;
        }

        Account acc = resolution.matchedAccount;
        Metrics m = metricsByAccount.get(acc.Id);
        result.found = true;
        result.matchType = resolution.matchType;
        result.accountId = acc.Id;
        result.accountName = acc.Name;
        result.industry = acc.Industry;
        result.ownerName = acc.Owner?.Name;
        result.openOpportunityCount = m.openOpportunityCount;
        result.openPipelineAmount = m.openPipelineAmount.setScale(2);
        result.weightedPipelineAmount = m.weightedPipelineAmount.setScale(2);
        result.opportunitiesClosingIn30Days = m.closingSoonCount;
        result.nextCloseDate = m.nextCloseDate;
        result.openCaseCount = m.openCaseCount;
        result.highPriorityOpenCaseCount = m.highPriorityCaseCount;
        result.lastActivityDate = latest(acc.LastActivityDate, m.lastClosedTaskDate);
        result.daysSinceLastActivity = result.lastActivityDate == null ? null : result.lastActivityDate.daysBetween(Date.today());
        result.healthScore = score(result);
        result.healthStatus = status(result.healthScore);
        result.summary = summarize(result);
        return result;
    }

    private static String notFoundMessage(AccountHealthRequest request) {
        if (request == null || (String.isBlank(request.accountId) && String.isBlank(request.accountName))) {
            return 'Provide accountId or accountName.';
        }
        if (String.isNotBlank(request.accountId) && toAccountId(request.accountId) == null && String.isBlank(request.accountName)) {
            return 'accountId "' + request.accountId + '" is not a valid Account Id.';
        }
        return 'No account you can access matches ' + (String.isNotBlank(request.accountName) ? '"' + request.accountName + '"' : request.accountId) + '.';
    }

    private static Date latest(Date first, Date second) {
        if (first == null) {
            return second;
        }
        if (second == null) {
            return first;
        }
        return first > second ? first : second;
    }

    /** 100 minus penalties for stale activity, open cases and an empty pipeline. */
    @TestVisible
    private static Integer score(AccountHealthResult r) {
        Integer value = 100;
        if (r.daysSinceLastActivity == null) {
            value -= 35;
        } else if (r.daysSinceLastActivity > STALE_ACTIVITY_DAYS) {
            value -= 25;
        }
        Integer highPriority = r.highPriorityOpenCaseCount == null ? 0 : r.highPriorityOpenCaseCount;
        Integer otherCases = (r.openCaseCount == null ? 0 : r.openCaseCount) - highPriority;
        value -= Math.min(highPriority * 15, 30);
        value -= Math.min(otherCases * 5, 15);
        if (r.openOpportunityCount == null || r.openOpportunityCount == 0) {
            value -= 15;
        }
        return Math.max(0, Math.min(100, value));
    }

    @TestVisible
    private static String status(Integer healthScore) {
        if (healthScore >= 75) {
            return 'Healthy';
        }
        if (healthScore >= 50) {
            return 'Watch';
        }
        return 'At Risk';
    }

    private static String summarize(AccountHealthResult r) {
        List<String> parts = new List<String>{
            r.accountName + ' is ' + r.healthStatus + ' (' + r.healthScore + '/100).',
            String.valueOf(r.openOpportunityCount) + ' open opportunities worth ' + r.openPipelineAmount.format()
                + ' (weighted ' + r.weightedPipelineAmount.format() + '), '
                + r.opportunitiesClosingIn30Days + ' closing within ' + CLOSING_SOON_DAYS + ' days.',
            String.valueOf(r.openCaseCount) + ' open cases (' + r.highPriorityOpenCaseCount + ' high priority).',
            r.lastActivityDate == null ? 'No logged activity.' : 'Last activity ' + r.daysSinceLastActivity + ' days ago.'
        };
        return String.join(parts, ' ');
    }

    private static List<AccountHealthResult> failAll(Integer size, String message) {
        List<AccountHealthResult> failures = new List<AccountHealthResult>();
        for (Integer i = 0; i < size; i++) {
            AccountHealthResult failure = new AccountHealthResult();
            failure.found = false;
            failure.message = message;
            failures.add(failure);
        }
        return failures;
    }

    // ------------------------------------------------------------------
    // Invocable input / output (become the MCP tool's input and output schema)
    // ------------------------------------------------------------------

    global class AccountHealthRequest {
        @InvocableVariable(label='Account Id' description='15- or 18-character Id of the Account. Takes precedence over accountName.')
        global String accountId;

        @InvocableVariable(label='Account Name' description='Account name to look up when the Id is unknown. Exact names win; otherwise the most recently modified partial match is used.')
        global String accountName;

        global AccountHealthRequest() {
        }
    }

    global class AccountHealthResult {
        @InvocableVariable(label='Found' description='True when an Account the user can access matched the request.')
        global Boolean found;

        @InvocableVariable(label='Match Type' description='How the Account was matched: id, name or partial.')
        global String matchType;

        @InvocableVariable(label='Message' description='Why no Account was returned, when found is false.')
        global String message;

        @InvocableVariable(label='Account Id' description='Id of the matched Account.')
        global Id accountId;

        @InvocableVariable(label='Account Name' description='Name of the matched Account.')
        global String accountName;

        @InvocableVariable(label='Industry' description='Industry of the Account.')
        global String industry;

        @InvocableVariable(label='Owner Name' description='Name of the Account owner.')
        global String ownerName;

        @InvocableVariable(label='Open Opportunities' description='Number of open (not closed) opportunities.')
        global Integer openOpportunityCount;

        @InvocableVariable(label='Open Pipeline Amount' description='Sum of Amount across open opportunities, in the org currency.')
        global Decimal openPipelineAmount;

        @InvocableVariable(label='Weighted Pipeline Amount' description='Sum of Amount x Probability across open opportunities.')
        global Decimal weightedPipelineAmount;

        @InvocableVariable(label='Closing In 30 Days' description='Open opportunities with a close date in the next 30 days (or overdue).')
        global Integer opportunitiesClosingIn30Days;

        @InvocableVariable(label='Next Close Date' description='Earliest close date among open opportunities.')
        global Date nextCloseDate;

        @InvocableVariable(label='Open Cases' description='Number of open cases.')
        global Integer openCaseCount;

        @InvocableVariable(label='High Priority Open Cases' description='Open cases with High or Critical priority.')
        global Integer highPriorityOpenCaseCount;

        @InvocableVariable(label='Last Activity Date' description='Most recent completed activity date on the Account.')
        global Date lastActivityDate;

        @InvocableVariable(label='Days Since Last Activity' description='Days since lastActivityDate; empty when there is no activity.')
        global Integer daysSinceLastActivity;

        @InvocableVariable(label='Health Score' description='0-100. Starts at 100; stale or missing activity, open cases and an empty pipeline reduce it.')
        global Integer healthScore;

        @InvocableVariable(label='Health Status' description='Healthy (75+), Watch (50-74) or At Risk (below 50).')
        global String healthStatus;

        @InvocableVariable(label='Summary' description='One-line, human-readable summary of the Account health.')
        global String summary;

        global AccountHealthResult() {
        }
    }
}
