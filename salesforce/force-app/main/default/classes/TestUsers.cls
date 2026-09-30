/**
 * Test helper: users with restricted access, to prove the tools respect the caller's permissions.
 */
@IsTest
public class TestUsers {

    /** A user on the "Minimum Access - Salesforce" profile, or null when the org has no such profile. */
    public static User minimumAccessUser() {
        List<Profile> profiles = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        if (profiles.isEmpty()) {
            return null;
        }
        String unique = String.valueOf(DateTime.now().getTime()) + String.valueOf(Math.abs(Crypto.getRandomInteger()));
        User restricted = new User(
            Alias = 'minacc',
            Email = 'min.access@headless360.example',
            EmailEncodingKey = 'UTF-8',
            FirstName = 'Minimum',
            LastName = 'Access',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profiles[0].Id,
            TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'min.access.' + unique + '@headless360.example'
        );
        insert restricted;
        return restricted;
    }
}
