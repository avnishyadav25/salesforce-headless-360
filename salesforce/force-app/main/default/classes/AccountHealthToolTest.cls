@IsTest
private class AccountHealthToolTest {

    private static final String HEALTHY_NAME = 'Acme Health Test';
    private static final String QUIET_NAME = 'Quiet Holdings Test';

    @TestSetup
    static void createData() {
        Account healthy = new Account(Name = HEALTHY_NAME, Industry = 'Technology');
        Account quiet = new Account(Name = QUIET_NAME);
        insert new List<Account>{ healthy, quiet };

        insert new List<Opportunity>{
            new Opportunity(Name = 'Acme Renewal', AccountId = healthy.Id, StageName = 'Prospecting', CloseDate = Date.today().addDays(10), Amount = 100000, Probability = 50),
            new Opportunity(Name = 'Acme Expansion', AccountId = healthy.Id, StageName = 'Prospecting', CloseDate = Date.today().addDays(90), Amount = 50000, Probability = 20),
            new Opportunity(Name = 'Acme Closed Deal', AccountId = healthy.Id, StageName = 'Closed Won', CloseDate = Date.today().addDays(-5), Amount = 999999, Probability = 100)
        };

        insert new List<Case>{
            new Case(Subject = 'Outage', AccountId = healthy.Id, Priority = 'High', Status = 'New', Origin = 'Web'),
            new Case(Subject = 'Question', AccountId = healthy.Id, Priority = 'Medium', Status = 'New', Origin = 'Web'),
            new Case(Subject = 'Old issue', AccountId = healthy.Id, Priority = 'High', Status = 'Closed', Origin = 'Web')
        };

        insert new Task(Subject = 'Quarterly call', WhatId = healthy.Id, Status = 'Completed', Priority = 'Normal', ActivityDate = Date.today().addDays(-10));
    }

    private static AccountHealthTool.AccountHealthResult runOne(AccountHealthTool.AccountHealthRequest request) {
        List<AccountHealthTool.AccountHealthResult> results = AccountHealthTool.getAccountHealth(
            new List<AccountHealthTool.AccountHealthRequest>{ request }
        );
        Assert.areEqual(1, results.size(), 'One result per request');
        return results[0];
    }

    private static AccountHealthTool.AccountHealthRequest byId(Id accountId) {
        AccountHealthTool.AccountHealthRequest request = new AccountHealthTool.AccountHealthRequest();
        request.accountId = accountId;
        return request;
    }

    private static AccountHealthTool.AccountHealthRequest byName(String name) {
        AccountHealthTool.AccountHealthRequest request = new AccountHealthTool.AccountHealthRequest();
        request.accountName = name;
        return request;
    }

    @IsTest
    static void returnsHealthSummaryById() {
        Account acc = [SELECT Id FROM Account WHERE Name = :HEALTHY_NAME LIMIT 1];

        Test.startTest();
        AccountHealthTool.AccountHealthResult result = runOne(byId(acc.Id));
        Test.stopTest();

        Assert.isTrue(result.found, 'Account should be found');
        Assert.areEqual('id', result.matchType, 'Matched by Id');
        Assert.areEqual(acc.Id, result.accountId, 'Returns the requested Account');
        Assert.areEqual(HEALTHY_NAME, result.accountName, 'Returns the Account name');
        Assert.areEqual('Technology', result.industry, 'Returns the industry');
        Assert.areEqual(2, result.openOpportunityCount, 'Closed opportunities are excluded');
        Assert.areEqual(150000, result.openPipelineAmount.intValue(), 'Open pipeline sums open amounts');
        Assert.areEqual(60000, result.weightedPipelineAmount.intValue(), 'Weighted pipeline uses probability');
        Assert.areEqual(1, result.opportunitiesClosingIn30Days, 'Only one deal closes within 30 days');
        Assert.areEqual(Date.today().addDays(10), result.nextCloseDate, 'Earliest open close date');
        Assert.areEqual(2, result.openCaseCount, 'Closed cases are excluded');
        Assert.areEqual(1, result.highPriorityOpenCaseCount, 'One open high-priority case');
        Assert.areEqual(Date.today().addDays(-10), result.lastActivityDate, 'Last completed activity');
        Assert.areEqual(10, result.daysSinceLastActivity, 'Days since last activity');
        // 100 - 15 (one high-priority case) - 5 (one other open case)
        Assert.areEqual(80, result.healthScore, 'Score applies case penalties only');
        Assert.areEqual('Healthy', result.healthStatus, '80 is Healthy');
        Assert.isTrue(result.summary.contains(HEALTHY_NAME), 'Summary names the Account');
        Assert.isTrue(result.summary.contains('2 open opportunities'), 'Summary includes the pipeline');
    }

    @IsTest
    static void matchesExactNameCaseInsensitively() {
        Test.startTest();
        AccountHealthTool.AccountHealthResult result = runOne(byName('  acme health test '));
        Test.stopTest();

        Assert.isTrue(result.found, 'Exact name should match');
        Assert.areEqual('name', result.matchType, 'Matched by exact name');
        Assert.areEqual(HEALTHY_NAME, result.accountName, 'Returns the matching Account');
    }

    @IsTest
    static void fallsBackToPartialName() {
        Test.startTest();
        AccountHealthTool.AccountHealthResult result = runOne(byName('Quiet Hold'));
        Test.stopTest();

        Assert.isTrue(result.found, 'Partial name should match');
        Assert.areEqual('partial', result.matchType, 'Matched by partial name');
        Assert.areEqual(QUIET_NAME, result.accountName, 'Returns the partially matching Account');
        Assert.areEqual(0, result.openOpportunityCount, 'No pipeline');
        Assert.areEqual(0, result.openCaseCount, 'No cases');
        Assert.isNull(result.lastActivityDate, 'No activity');
        Assert.isNull(result.daysSinceLastActivity, 'No activity age');
        // 100 - 35 (no activity) - 15 (no open pipeline)
        Assert.areEqual(50, result.healthScore, 'Score penalizes no activity and no pipeline');
        Assert.areEqual('Watch', result.healthStatus, '50 is Watch');
        Assert.isTrue(result.summary.contains('No logged activity.'), 'Summary mentions missing activity');
    }

    @IsTest
    static void explainsWhyNothingMatched() {
        AccountHealthTool.AccountHealthRequest invalidId = byId(null);
        invalidId.accountId = 'not-an-id';

        Test.startTest();
        List<AccountHealthTool.AccountHealthResult> results = AccountHealthTool.getAccountHealth(
            new List<AccountHealthTool.AccountHealthRequest>{
                byName('No Such Company Anywhere'),
                new AccountHealthTool.AccountHealthRequest(),
                invalidId,
                byId(UserInfo.getUserId()),
                null
            }
        );
        Test.stopTest();

        Assert.areEqual(5, results.size(), 'One result per request, in order');
        for (AccountHealthTool.AccountHealthResult result : results) {
            Assert.isFalse(result.found, 'Nothing should match');
            Assert.isNotNull(result.message, 'Explains why');
        }
        Assert.isTrue(results[0].message.contains('No Such Company Anywhere'), 'Echoes the name searched');
        Assert.areEqual('Provide accountId or accountName.', results[1].message, 'Empty request');
        Assert.isTrue(results[2].message.contains('not a valid Account Id'), 'Invalid Id');
        Assert.isTrue(results[3].message.contains('not a valid Account Id'), 'A User Id is not an Account Id');
        Assert.areEqual('Provide accountId or accountName.', results[4].message, 'Null request');
    }

    @IsTest
    static void handlesBulkRequestsInOrder() {
        Account healthy = [SELECT Id FROM Account WHERE Name = :HEALTHY_NAME LIMIT 1];

        Test.startTest();
        List<AccountHealthTool.AccountHealthResult> results = AccountHealthTool.getAccountHealth(
            new List<AccountHealthTool.AccountHealthRequest>{ byName(QUIET_NAME), byId(healthy.Id) }
        );
        Test.stopTest();

        Assert.areEqual(QUIET_NAME, results[0].accountName, 'First result matches first request');
        Assert.areEqual(HEALTHY_NAME, results[1].accountName, 'Second result matches second request');
        Assert.areEqual(0, AccountHealthTool.getAccountHealth(new List<AccountHealthTool.AccountHealthRequest>()).size(), 'Empty input');
        Assert.areEqual(0, AccountHealthTool.getAccountHealth(null).size(), 'Null input');
    }

    @IsTest
    static void scoresAreClampedAndBucketed() {
        AccountHealthTool.AccountHealthResult bad = new AccountHealthTool.AccountHealthResult();
        bad.daysSinceLastActivity = AccountHealthTool.STALE_ACTIVITY_DAYS + 1;
        bad.openCaseCount = 12;
        bad.highPriorityOpenCaseCount = 6;
        bad.openOpportunityCount = 0;

        // 100 - 25 (stale) - 30 (capped high priority) - 15 (capped other cases) - 15 (no pipeline)
        Assert.areEqual(15, AccountHealthTool.score(bad), 'Penalties are capped');
        Assert.areEqual('At Risk', AccountHealthTool.status(15), 'Below 50 is At Risk');
        Assert.areEqual('Watch', AccountHealthTool.status(74), '74 is Watch');
        Assert.areEqual('Healthy', AccountHealthTool.status(75), '75 is Healthy');

        AccountHealthTool.AccountHealthResult empty = new AccountHealthTool.AccountHealthResult();
        Assert.areEqual(50, AccountHealthTool.score(empty), 'Nulls count as no activity and no pipeline');
    }

    @IsTest
    static void respectsTheCallersAccess() {
        User restricted = TestUsers.minimumAccessUser();
        if (restricted == null) {
            return; // Org has no Minimum Access profile; the other tests still cover the logic.
        }

        AccountHealthTool.AccountHealthResult result;
        Test.startTest();
        System.runAs(restricted) {
            result = runOne(byName(HEALTHY_NAME));
        }
        Test.stopTest();

        Assert.isFalse(result.found, 'A user without Account access sees nothing');
        Assert.isNotNull(result.message, 'Explains the failure');
    }
}
