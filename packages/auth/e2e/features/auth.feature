Feature: The door — sign in, and what a role may do

  @anonymous
  Scenario: An anonymous browser meets the sign-in page instead of the board
    Given I open odu
    Then the page asks me to sign in
    And the page offers no board rows
    And there should be no page errors

  @signed-in:member
  Scenario: Signing in lands on the board with the header
    Given I open the board
    Then the header names "odu-e2e" as "member"
    And the page offers the board rows
    And there should be no page errors

  @anonymous
  Scenario: A login outside the allow-list is refused with a reason
    Given the stub says this account is not in the organisation
    When I start a sign-in
    Then the page refuses the sign-in naming the allow-list
    And the page reports no errors other than the refused sign-in

  @signed-in:member
  Scenario: A member may read the board and may not administer buckets
    When the API creates a bucket as this person
    Then the API refuses it as not permitted
    And the API lists buckets as this person
    And I open the cache
    Then the page shows the bucket list
    And the page offers no Create bucket control
    And there should be no page errors

  @signed-in:admin
  Scenario: An admin creates a bucket from the API, and is offered the control
    When the API creates a bucket as this person
    Then the API reports the bucket
    And I open the cache
    Then a bucket row names it
    And the page offers a Create bucket control
    And there should be no page errors

  @signed-in:member
  Scenario: A token created on the profile page drives odu surface --origin
    When I open the profile
    And I create a token named "laptop"
    Then the page shows the token once
    And the API with that token answers whoami as this person
    And the API lists buckets with that token
    And there should be no page errors

  @signed-in:member
  Scenario: A token created on the profile page shows its expiry
    When I open the profile
    And I create a token named "laptop-expiring"
    Then the profile shows an expiry for "laptop-expiring"
    And there should be no page errors

  @signed-in:member
  Scenario: Signing out in one tab closes the other tab
    Given I open a second tab on the board
    And I open the profile
    When I sign out
    Then the second tab meets the sign-in page
    And there should be no page errors

  @signed-in:owner
  Scenario: An owner sees who is in, grants a role and changes it
    When I open the people page
    Then the people list shows "odu-e2e" as "owner"
    When I grant a new login the role "admin"
    Then the people page says "is now admin"
    And the people list shows the new login as "admin"
    When I change the new login's role to "member"
    Then the people list shows the new login as "member"
    And there should be no page errors

  @signed-in:owner
  Scenario: An empty login is refused by the row, in its words
    When I open the people page
    And I press "Grant"
    Then the people page says "a grant needs a GitHub login"
    And there should be no page errors

  @signed-in:admin
  Scenario: An admin is offered no people page, and the row refuses the list
    Given I open the board
    Then the header offers no People control
    And the API refuses the people list as not permitted
    And there should be no page errors
