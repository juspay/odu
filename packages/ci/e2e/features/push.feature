Feature: A node's cache push is its own step

  Scenario: A node that pushed shows the push step, and its lines live in their own log
    Given a settled run whose node pushed to a bucket of this daemon
    And I open that run
    Then the run header says it pushes to that bucket
    And the run header totals what the run pushed
    And the node "warm@" shows its push step
    And the node "_ci-setup@" shows no push step
    When I open the output of "warm@"
    Then the output does not hold "[odu] pushing"
    And I note the log panel's size
    When I read the push log
    Then the output holds "[odu] pushing 1 result path"
    And the log panel names the push log at a size of its own
    And there should be no page errors
