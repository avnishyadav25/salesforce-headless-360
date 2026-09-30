// Demo data for the Headless 360 assistant and the series walkthroughs.
// Run it in a Developer Edition org, never in production:
//   sf apex run --file scripts/apex/seed-demo-data.apex --target-org headless360
// Safe to run twice: an account that already exists is skipped with its records.
//
// Acme (Demo)   -> "At Risk"/"Watch": a big deal closing soon, an open high-priority case, no activity for 40 days.
// Globex (Demo) -> "Healthy": pipeline, no open cases, a completed call 3 days ago.

List<String> demoNames = new List<String>{ 'Acme (Demo)', 'Globex (Demo)' };
Set<String> present = new Set<String>();
for (Account existing : [SELECT Name FROM Account WHERE Name IN :demoNames]) {
    present.add(existing.Name);
}
Date today = Date.today();

if (!present.contains('Acme (Demo)')) {
    Account acme = new Account(Name = 'Acme (Demo)', Industry = 'Technology');
    insert acme;
    insert new List<Opportunity>{
        new Opportunity(AccountId = acme.Id, Name = 'Acme (Demo) - Platform renewal', StageName = 'Negotiation/Review', CloseDate = today.addDays(10), Amount = 120000),
        new Opportunity(AccountId = acme.Id, Name = 'Acme (Demo) - Support add-on', StageName = 'Prospecting', CloseDate = today.addDays(45), Amount = 30000),
        new Opportunity(AccountId = acme.Id, Name = 'Acme (Demo) - Pilot', StageName = 'Closed Won', CloseDate = today.addDays(-60), Amount = 15000)
    };
    insert new List<Case>{
        new Case(AccountId = acme.Id, Subject = 'Login errors after SSO change', Priority = 'High', Status = 'New'),
        new Case(AccountId = acme.Id, Subject = 'Invoice address update', Priority = 'Low', Status = 'New')
    };
    insert new Task(WhatId = acme.Id, Subject = 'Quarterly review call', Status = 'Completed', Priority = 'Normal', ActivityDate = today.addDays(-40));
    System.debug('Created Acme (Demo): ' + acme.Id);
} else {
    System.debug('Acme (Demo) already exists, skipped');
}

if (!present.contains('Globex (Demo)')) {
    Account globex = new Account(Name = 'Globex (Demo)', Industry = 'Manufacturing');
    insert globex;
    insert new List<Opportunity>{
        new Opportunity(AccountId = globex.Id, Name = 'Globex (Demo) - Expansion', StageName = 'Prospecting', CloseDate = today.addDays(20), Amount = 80000)
    };
    insert new Task(WhatId = globex.Id, Subject = 'Kick-off call', Status = 'Completed', Priority = 'Normal', ActivityDate = today.addDays(-3));
    System.debug('Created Globex (Demo): ' + globex.Id);
} else {
    System.debug('Globex (Demo) already exists, skipped');
}
