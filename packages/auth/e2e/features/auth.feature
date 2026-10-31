Feature: The door — sign in, and what a role may do
  # The page a person meets before the board, the role they hold once in, and
  # the two credentials that let a machine act as them. Every scenario declares
  # its world by tag: @anonymous and @signed-in:<role> run against a daemon with
  # sign-in configured (pointed at the stub), and an untagged scenario runs
  # against today's loopback daemon, unchanged.
  #
  # Signing in is a person's route: the sign-in page's link goes to this
  # daemon's /auth/github, the stub authorises at once, and the callback lands
  # back on the board with a session cookie. Nothing here types a cookie.

  @anonymous
  Scenario: An anonymous browser meets the sign-in page instead of the board
    Given I open the board
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
    And there should be no page errors

  @signed-in:member
  Scenario: A member may read the board and may not administer buckets
    When the CLI creates a bucket as this person
    Then the CLI refuses it as not permitted
    And I open the cache
    Then the page shows the bucket list
    And the page offers no Create bucket control
    And there should be no page errors

  @signed-in:admin
  Scenario: An admin creates a bucket from the CLI
    When the CLI creates a bucket as this person
    Then the CLI reports the bucket
    And I open the cache
    Then a bucket row names it
    And there should be no page errors

  @signed-in:admin
  Scenario: A token created on the profile page drives odu --origin
    When I open the profile
    And I create a token named "laptop"
    Then the page shows the token once
    And a CLI with that token answers whoami as this person
    And the CLI lists buckets with that token
    And there should be no page errors

  @signed-in:member
  Scenario: Signing out in one tab closes the other tab
    Given I open a second tab on the board
    And I open the profile
    When I sign out
    Then the second tab meets the sign-in page
    And there should be no page errors
