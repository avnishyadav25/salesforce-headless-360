/**
 * Custom MCP tool: create a follow-up Task, with validation.
 *
 * Published as the `createFollowUpTask` tool of the custom Salesforce Hosted MCP server
 * `Headless_Assistant_Tools`. The web app treats it as a write tool: it stays disabled
 * until the user approves a specific proposal.
 *
 * Security: `with sharing`, USER_MODE queries and USER_MODE DML, so the task is created
 * as the signed-in user and only on records that user can see. Re-running the same
 * request returns the existing open task instead of creating a duplicate, which keeps
 * agent retries safe.
 */
global with sharing class CreateFollowUpTaskTool {

    @TestVisible
    private static final Integer DEFAULT_DAYS_AHEAD = 3;
    @TestVisible
    private static final Integer MAX_DAYS_AHEAD = 365;
    private static final Integer MAX_SUBJECT_LENGTH = 255;
    private static final Integer MAX_DESCRIPTION_LENGTH = 32000;
    private static final Set<String> PRIORITIES = new Set<String>{ 'High', 'Normal', 'Low' };
    private static final Set<Schema.SObjectType> WHAT_TYPES = new Set<Schema.SObjectType>{
        Account.SObjectType,
        Opportunity.SObjectType,
        Case.SObjectType
    };
    private static final Set<Schema.SObjectType> WHO_TYPES = new Set<Schema.SObjectType>{
        Contact.SObjectType,
        Lead.SObjectType
    };

    @InvocableMethod(
        label='Create Follow-Up Task'
        description='Creates an open follow-up Task for the current user on an Account, Opportunity or Case (WhatId) or a Contact or Lead (WhoId). Validates the inputs, checks the user can see the record, and returns the existing open task instead of a duplicate when the same subject and due date already exist on that record.'
    )
    global static List<CreateFollowUpTaskResult> createFollowUpTask(List<CreateFollowUpTaskRequest> requests) {
        List<CreateFollowUpTaskResult> results = new List<CreateFollowUpTaskResult>();
        if (requests == null || requests.isEmpty()) {
            return results;
        }

        List<Task> candidates = new List<Task>();
        for (CreateFollowUpTaskRequest request : requests) {
            CreateFollowUpTaskResult result = new CreateFollowUpTaskResult();
            results.add(result);
            candidates.add(buildTask(request, result));
        }

        try {
            Set<Id> visibleTargets = findVisibleTargets(candidates);
            Map<String, Id> openDuplicates = findOpenDuplicates(candidates);

            List<Task> toInsert = new List<Task>();
            List<Integer> insertPositions = new List<Integer>();
            for (Integer i = 0; i < candidates.size(); i++) {
                Task candidate = candidates[i];
                if (candidate == null) {
                    continue;
                }
                CreateFollowUpTaskResult result = results[i];
                Id target = targetId(candidate);
                if (!visibleTargets.contains(target)) {
                    result.validationErrors.add('Record ' + target + ' was not found or you do not have access to it.');
                    continue;
                }
                Id existing = openDuplicates.get(duplicateKey(candidate));
                if (existing != null) {
                    result.success = true;
                    result.taskId = existing;
                    result.message = 'An open task with this subject and due date already exists on the record; no duplicate was created.';
                    continue;
                }
                toInsert.add(candidate);
                insertPositions.add(i);
            }

            if (!toInsert.isEmpty()) {
                List<Database.SaveResult> saveResults = Database.insert(toInsert, false, AccessLevel.USER_MODE);
                for (Integer j = 0; j < saveResults.size(); j++) {
                    CreateFollowUpTaskResult result = results[insertPositions[j]];
                    Database.SaveResult saveResult = saveResults[j];
                    if (saveResult.isSuccess()) {
                        result.success = true;
                        result.created = true;
                        result.taskId = saveResult.getId();
                        result.message = 'Created task "' + toInsert[j].Subject + '" due ' + String.valueOf(toInsert[j].ActivityDate) + '.';
                    } else {
                        for (Database.Error error : saveResult.getErrors()) {
                            result.validationErrors.add(error.getMessage());
                        }
                    }
                }
            }
        } catch (Exception e) {
            // User-mode queries and DML throw when the caller lacks access; report it per request.
            for (CreateFollowUpTaskResult result : results) {
                if (result.success != true && result.validationErrors.isEmpty()) {
                    result.validationErrors.add('Salesforce denied the request: ' + e.getMessage());
                }
            }
        }

        for (CreateFollowUpTaskResult result : results) {
            if (result.success != true) {
                result.success = false;
                result.message = 'Task not created. ' + String.join(result.validationErrors, ' ');
            }
        }
        return results;
    }

    private static Task buildTask(CreateFollowUpTaskRequest request, CreateFollowUpTaskResult result) {
        if (request == null) {
            result.validationErrors.add('The request is empty.');
            return null;
        }

        Id recordId = parseId(request.recordId);
        Schema.SObjectType recordType = recordId == null ? null : recordId.getSObjectType();
        String subject = request.subject == null ? '' : request.subject.trim();
        Date dueDate = request.dueDate == null ? Date.today().addDays(DEFAULT_DAYS_AHEAD) : request.dueDate;
        String priority = String.isBlank(request.priority) ? 'Normal' : request.priority.trim().toLowerCase().capitalize();

        if (recordId == null) {
            result.validationErrors.add('recordId must be a valid Salesforce record Id.');
        } else if (!WHAT_TYPES.contains(recordType) && !WHO_TYPES.contains(recordType)) {
            result.validationErrors.add('Follow-up tasks can be attached to an Account, Opportunity, Case, Contact or Lead, not ' + String.valueOf(recordType) + '.');
        }
        if (String.isBlank(subject)) {
            result.validationErrors.add('subject is required.');
        } else if (subject.length() > MAX_SUBJECT_LENGTH) {
            result.validationErrors.add('subject must be ' + MAX_SUBJECT_LENGTH + ' characters or fewer.');
        }
        if (dueDate < Date.today()) {
            result.validationErrors.add('dueDate cannot be in the past.');
        } else if (dueDate > Date.today().addDays(MAX_DAYS_AHEAD)) {
            result.validationErrors.add('dueDate must be within ' + MAX_DAYS_AHEAD + ' days.');
        }
        if (!PRIORITIES.contains(priority)) {
            result.validationErrors.add('priority must be High, Normal or Low.');
        }
        if (request.description != null && request.description.length() > MAX_DESCRIPTION_LENGTH) {
            result.validationErrors.add('description must be ' + MAX_DESCRIPTION_LENGTH + ' characters or fewer.');
        }
        if (!result.validationErrors.isEmpty()) {
            return null;
        }

        Task followUp = new Task(
            Subject = subject,
            ActivityDate = dueDate,
            Priority = priority,
            Status = 'Not Started',
            Description = request.description
        );
        if (WHAT_TYPES.contains(recordType)) {
            followUp.WhatId = recordId;
        } else {
            followUp.WhoId = recordId;
        }
        return followUp;
    }

    private static Id parseId(String value) {
        if (String.isBlank(value)) {
            return null;
        }
        try {
            return Id.valueOf(value.trim());
        } catch (StringException e) {
            return null;
        }
    }

    private static Id targetId(Task t) {
        return t.WhatId != null ? t.WhatId : t.WhoId;
    }

    private static String duplicateKey(Task t) {
        return String.valueOf(targetId(t)) + '|' + t.Subject.toLowerCase() + '|' + String.valueOf(t.ActivityDate);
    }

    /** Ids the user can actually see, one USER_MODE query per object type. */
    private static Set<Id> findVisibleTargets(List<Task> candidates) {
        Map<Schema.SObjectType, Set<Id>> idsByType = new Map<Schema.SObjectType, Set<Id>>();
        for (Task candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            Id target = targetId(candidate);
            Schema.SObjectType objectType = target.getSObjectType();
            if (!idsByType.containsKey(objectType)) {
                idsByType.put(objectType, new Set<Id>());
            }
            idsByType.get(objectType).add(target);
        }

        Set<Id> visible = new Set<Id>();
        for (Schema.SObjectType objectType : idsByType.keySet()) {
            // The object name comes from the schema, never from user input.
            String soql = 'SELECT Id FROM ' + objectType.getDescribe().getName() + ' WHERE Id IN :ids';
            Map<String, Object> binds = new Map<String, Object>{ 'ids' => idsByType.get(objectType) };
            for (SObject record : Database.queryWithBinds(soql, binds, AccessLevel.USER_MODE)) {
                visible.add(record.Id);
            }
        }
        return visible;
    }

    private static Map<String, Id> findOpenDuplicates(List<Task> candidates) {
        Set<Id> targets = new Set<Id>();
        Set<String> subjects = new Set<String>();
        for (Task candidate : candidates) {
            if (candidate != null) {
                targets.add(targetId(candidate));
                subjects.add(candidate.Subject);
            }
        }

        Map<String, Id> existing = new Map<String, Id>();
        if (targets.isEmpty()) {
            return existing;
        }
        for (Task openTask : [
            SELECT Id, WhatId, WhoId, Subject, ActivityDate
            FROM Task
            WHERE IsClosed = false AND Subject IN :subjects AND (WhatId IN :targets OR WhoId IN :targets)
            WITH USER_MODE
            LIMIT 2000
        ]) {
            existing.put(duplicateKey(openTask), openTask.Id);
        }
        return existing;
    }

    // ------------------------------------------------------------------
    // Invocable input / output (become the MCP tool's input and output schema)
    // ------------------------------------------------------------------

    global class CreateFollowUpTaskRequest {
        @InvocableVariable(label='Related Record Id' description='Id of the Account, Opportunity or Case (WhatId), or the Contact or Lead (WhoId), that the task follows up on.' required=true)
        global String recordId;

        @InvocableVariable(label='Subject' description='Short task subject, for example "Send renewal quote". Up to 255 characters.' required=true)
        global String subject;

        @InvocableVariable(label='Due Date' description='Due date (YYYY-MM-DD). Defaults to 3 days from today. Must be today or later and within 365 days.')
        global Date dueDate;

        @InvocableVariable(label='Priority' description='High, Normal or Low. Defaults to Normal.')
        global String priority;

        @InvocableVariable(label='Description' description='Optional details for the task comments.')
        global String description;

        global CreateFollowUpTaskRequest() {
        }
    }

    global class CreateFollowUpTaskResult {
        @InvocableVariable(label='Success' description='True when an open task for this follow-up exists after the call (created now or already there).')
        global Boolean success = false;

        @InvocableVariable(label='Created' description='True only when this call created a new task.')
        global Boolean created = false;

        @InvocableVariable(label='Task Id' description='Id of the created or existing task.')
        global Id taskId;

        @InvocableVariable(label='Message' description='Human-readable outcome, including validation errors.')
        global String message;

        @InvocableVariable(label='Validation Errors' description='Each validation or permission problem that stopped the task from being created.')
        global List<String> validationErrors = new List<String>();

        global CreateFollowUpTaskResult() {
        }
    }
}
