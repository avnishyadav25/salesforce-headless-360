@IsTest
private class CreateFollowUpTaskToolTest {

    @TestSetup
    static void createData() {
        Account acc = new Account(Name = 'Follow Up Test Account');
        insert acc;
        insert new Opportunity(Name = 'Follow Up Test Deal', AccountId = acc.Id, StageName = 'Prospecting', CloseDate = Date.today().addDays(30));
        insert new Contact(LastName = 'Follow Up Contact', AccountId = acc.Id);
    }

    private static Id accountId() {
        return [SELECT Id FROM Account WHERE Name = 'Follow Up Test Account' LIMIT 1].Id;
    }

    private static CreateFollowUpTaskTool.CreateFollowUpTaskRequest request(Id recordId, String subject) {
        CreateFollowUpTaskTool.CreateFollowUpTaskRequest req = new CreateFollowUpTaskTool.CreateFollowUpTaskRequest();
        req.recordId = recordId;
        req.subject = subject;
        return req;
    }

    private static List<CreateFollowUpTaskTool.CreateFollowUpTaskResult> run(List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest> requests) {
        return CreateFollowUpTaskTool.createFollowUpTask(requests);
    }

    @IsTest
    static void createsTaskOnAccount() {
        CreateFollowUpTaskTool.CreateFollowUpTaskRequest req = request(accountId(), '  Send renewal quote ');
        req.dueDate = Date.today().addDays(7);
        req.priority = 'high';
        req.description = 'Customer asked for three-year pricing.';

        Test.startTest();
        CreateFollowUpTaskTool.CreateFollowUpTaskResult result = run(new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{ req })[0];
        Test.stopTest();

        Assert.isTrue(result.success, 'Task should be created: ' + result.message);
        Assert.isTrue(result.created, 'A new task was created');
        Assert.isNotNull(result.taskId, 'Returns the task Id');
        Assert.isTrue(result.validationErrors.isEmpty(), 'No validation errors');

        Task created = [SELECT Subject, WhatId, WhoId, ActivityDate, Priority, Status, Description, OwnerId FROM Task WHERE Id = :result.taskId];
        Assert.areEqual('Send renewal quote', created.Subject, 'Subject is trimmed');
        Assert.areEqual(accountId(), created.WhatId, 'Attached to the Account');
        Assert.isNull(created.WhoId, 'No WhoId for an Account');
        Assert.areEqual(Date.today().addDays(7), created.ActivityDate, 'Due date as requested');
        Assert.areEqual('High', created.Priority, 'Priority is normalized');
        Assert.areEqual('Not Started', created.Status, 'Task starts open');
        Assert.areEqual('Customer asked for three-year pricing.', created.Description, 'Description is kept');
        Assert.areEqual(UserInfo.getUserId(), created.OwnerId, 'Owned by the calling user');
    }

    @IsTest
    static void appliesDefaultsAndSupportsOpportunitiesAndContacts() {
        Id opportunityId = [SELECT Id FROM Opportunity LIMIT 1].Id;
        Id contactId = [SELECT Id FROM Contact LIMIT 1].Id;

        Test.startTest();
        List<CreateFollowUpTaskTool.CreateFollowUpTaskResult> results = run(
            new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{
                request(opportunityId, 'Confirm decision maker'),
                request(contactId, 'Book intro call')
            }
        );
        Test.stopTest();

        Assert.isTrue(results[0].success && results[1].success, 'Both tasks should be created');
        Task onOpportunity = [SELECT WhatId, ActivityDate, Priority FROM Task WHERE Id = :results[0].taskId];
        Assert.areEqual(opportunityId, onOpportunity.WhatId, 'Opportunity goes to WhatId');
        Assert.areEqual(Date.today().addDays(CreateFollowUpTaskTool.DEFAULT_DAYS_AHEAD), onOpportunity.ActivityDate, 'Default due date');
        Assert.areEqual('Normal', onOpportunity.Priority, 'Default priority');
        Task onContact = [SELECT WhoId, WhatId FROM Task WHERE Id = :results[1].taskId];
        Assert.areEqual(contactId, onContact.WhoId, 'Contact goes to WhoId');
    }

    @IsTest
    static void rejectsInvalidInput() {
        CreateFollowUpTaskTool.CreateFollowUpTaskRequest badEverything = request(null, '   ');
        badEverything.recordId = 'not-an-id';
        badEverything.dueDate = Date.today().addDays(-1);
        badEverything.priority = 'Urgent';

        CreateFollowUpTaskTool.CreateFollowUpTaskRequest tooFar = request(accountId(), 'Check in next year');
        tooFar.dueDate = Date.today().addDays(CreateFollowUpTaskTool.MAX_DAYS_AHEAD + 1);

        CreateFollowUpTaskTool.CreateFollowUpTaskRequest longSubject = request(accountId(), 'x'.repeat(256));
        CreateFollowUpTaskTool.CreateFollowUpTaskRequest wrongObject = request(UserInfo.getUserId(), 'Follow up with myself');

        Test.startTest();
        List<CreateFollowUpTaskTool.CreateFollowUpTaskResult> results = run(
            new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{ badEverything, tooFar, longSubject, wrongObject, null }
        );
        Test.stopTest();

        Assert.areEqual(5, results.size(), 'One result per request');
        for (CreateFollowUpTaskTool.CreateFollowUpTaskResult result : results) {
            Assert.isFalse(result.success, 'Invalid requests fail');
            Assert.isFalse(result.created, 'Nothing is created');
            Assert.isTrue(result.message.startsWith('Task not created.'), 'Message explains the failure');
        }
        Assert.areEqual(4, results[0].validationErrors.size(), 'recordId, subject, dueDate and priority are all reported');
        Assert.isTrue(results[1].message.contains('within 365 days'), 'Due date too far out');
        Assert.isTrue(results[2].message.contains('255 characters'), 'Subject too long');
        Assert.isTrue(results[3].message.contains('not User'), 'Users are not valid targets');
        Assert.isTrue(results[4].message.contains('empty'), 'Null request');
        Assert.areEqual(0, [SELECT COUNT() FROM Task], 'No task was inserted');
    }

    @IsTest
    static void returnsExistingOpenTaskInsteadOfDuplicate() {
        CreateFollowUpTaskTool.CreateFollowUpTaskRequest req = request(accountId(), 'Send renewal quote');
        req.dueDate = Date.today().addDays(5);

        Test.startTest();
        CreateFollowUpTaskTool.CreateFollowUpTaskResult first = run(new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{ req })[0];
        CreateFollowUpTaskTool.CreateFollowUpTaskResult second = run(new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{ req })[0];
        Test.stopTest();

        Assert.isTrue(first.created, 'First call creates the task');
        Assert.isTrue(second.success, 'Second call succeeds');
        Assert.isFalse(second.created, 'Second call does not create a duplicate');
        Assert.areEqual(first.taskId, second.taskId, 'Second call returns the existing task');
        Assert.areEqual(1, [SELECT COUNT() FROM Task], 'Only one task exists');
    }

    @IsTest
    static void handlesEmptyInput() {
        Assert.areEqual(0, CreateFollowUpTaskTool.createFollowUpTask(null).size(), 'Null input');
        Assert.areEqual(0, CreateFollowUpTaskTool.createFollowUpTask(new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>()).size(), 'Empty input');
    }

    @IsTest
    static void respectsTheCallersAccess() {
        Id targetAccount = accountId();
        User restricted = TestUsers.minimumAccessUser();
        if (restricted == null) {
            return; // Org has no Minimum Access profile; the other tests still cover the logic.
        }

        CreateFollowUpTaskTool.CreateFollowUpTaskResult result;
        Test.startTest();
        System.runAs(restricted) {
            result = run(new List<CreateFollowUpTaskTool.CreateFollowUpTaskRequest>{ request(targetAccount, 'Not allowed') })[0];
        }
        Test.stopTest();

        Assert.isFalse(result.success, 'A user who cannot see the Account cannot add a task to it');
        Assert.isFalse(result.validationErrors.isEmpty(), 'Explains the failure');
        Assert.areEqual(0, [SELECT COUNT() FROM Task], 'No task was inserted');
    }
}
