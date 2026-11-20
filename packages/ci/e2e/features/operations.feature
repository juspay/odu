Feature: The board does everything odu does for runs

  Scenario: Preview pipeline reads the checkout's recipes
    Given a fixture checkout whose pipeline fails
    And I open the create form
    When I fill "Checkout" with the fixture path
    And I press "Preview pipeline"
    Then the pipeline preview names "alpha"
    And the pipeline preview names "beta"
    And there should be no page errors

  Scenario: Preview pipeline with no checkout is refused by the service
    Given I open the create form
    When I press "Preview pipeline"
    Then an alert reads "is not an absolute path"

  Scenario: The form starts a run with only the named recipe (--no-deps)
    Given a fixture checkout whose pipeline fails
    And I open the create form
    When I fill "Checkout" with the fixture path
    And I fill "Expected commit" with the fixture HEAD
    And I fill "Recipes" with "beta"
    And I tick "Run only the named recipes, not what they need (--no-deps)"
    And I tick "Do not post GitHub commit statuses (--no-post)"
    And I press "Start run"
    Then the address names a run
    And the run detail shows the node "beta@"
    And there should be no page errors

  Scenario: The machines page reads the last probe, and probes on request
    Given I open the machines page
    When I press "Probe machines"
    Then the machines page lists this machine's platform
    And the machines page says how old its reading is
    And there should be no page errors

  Scenario: A hold is taken and released from the machines page
    Given a fixture checkout whose pipeline fails
    And I open the machines page
    When I press "Hold a machine"
    And I fill "Checkout" with the fixture path
    And I fill "Platforms" with this machine's platform
    And I press "Hold"
    Then the page answers with a receipt
    When I press "Release"
    Then a status reports the release of this machine's platform
    And there is no alert
    And there should be no page errors

  Scenario: Expiring old runs is a dry run first
    Given I open the maintenance page
    When I press "Prune"
    Then a status reads "Would expire"
    And there should be no page errors

  Scenario: A retention of zero days is refused by the service
    Given I open the maintenance page
    When I fill "Retention (days)" with "0"
    And I press "Prune"
    Then an alert reads "positive whole number of days"

  Scenario: Importing a checkout's records is a dry run first
    Given a fixture checkout whose pipeline fails
    And I open the maintenance page
    When I fill "Checkout to import" with the fixture path
    And I press "Import"
    Then a status reads "Would import"
    And there should be no page errors

  Scenario: Branch protection shows the contexts it would require
    Given a fixture checkout whose pipeline fails
    And I open the maintenance page
    When I fill "Checkout to protect" with the fixture path
    And I fill "Platforms" with this machine's platform
    And I press "Apply protection"
    Then a status reads "Would require"
    And there should be no page errors
