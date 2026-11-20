Feature: A live run, its early failure, and its controls

  Background:
    Given a run of the fixture where one lane fails at once and its sibling sleeps
    And I open that run

  Scenario: The early failure is shown while the sibling is still running
    Then the node "quick@" is failed
    And the node "slow@" is running
    And the run has reached no outcome

  Scenario: Retrying a node on a live run is a new attempt, and the receipt says so
    When I press "Retry" on "quick@"
    Then a status reads "Reset"
    And a status reads "on this run"
    And the node "quick@" reaches "attempt 2"
    And there should be no page errors

  Scenario: Cancelling one node leaves the rest of the run alone
    When I press "Cancel node" on "slow@"
    Then a status reads "Stopped slow@"
    And the node "quick@" is failed

  Scenario: Cancelling one lane says the rest of the run continues
    When I press the cancel button for this machine's lane
    Then a status reads "the rest of the run continues"

  Scenario: Cancelling the whole run reports what it told the coordinator
    When I press "Cancel run"
    And I press "Yes, cancel it"
    Then a status reads "Told the coordinator to stop"
    And there should be no page errors
