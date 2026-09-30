// Removes everything seed-demo-data.apex created, plus tasks that Claude or the app added to the demo records.
//   sf apex run --file scripts/apex/remove-demo-data.apex --target-org headless360
List<String> demoNames = new List<String>{ 'Acme (Demo)', 'Globex (Demo)' };
Map<Id, Account> accounts = new Map<Id, Account>([SELECT Id FROM Account WHERE Name IN :demoNames]);
if (accounts.isEmpty()) {
    System.debug('No demo accounts found');
} else {
    Set<Id> accountIds = accounts.keySet();
    Map<Id, Opportunity> opps = new Map<Id, Opportunity>([SELECT Id FROM Opportunity WHERE AccountId IN :accountIds]);
    Map<Id, Case> cases = new Map<Id, Case>([SELECT Id FROM Case WHERE AccountId IN :accountIds]);
    Set<Id> parentIds = new Set<Id>(accountIds);
    parentIds.addAll(opps.keySet());
    parentIds.addAll(cases.keySet());
    List<Task> tasks = [SELECT Id FROM Task WHERE WhatId IN :parentIds];
    delete tasks;
    delete cases.values();
    delete opps.values();
    delete accounts.values();
    System.debug('Removed ' + accounts.size() + ' accounts, ' + opps.size() + ' opportunities, ' + cases.size() + ' cases, ' + tasks.size() + ' tasks');
}
