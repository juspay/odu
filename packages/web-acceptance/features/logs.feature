Feature: Reading a node's output
  # A log is where a red run stops being a colour and becomes a diagnosis, so
  # what is graded here is that a person can get to the RIGHT one: this node,
  # this attempt, this part of it — and that the address they end up with is the
  # same string an agent would echo.

  Scenario: Selecting a node opens its output and puts the log key in the address
    Given a settled red run of the failing fixture
    And I open that run
    When I open the output of "beta@"
    Then the output holds "beta is about to fail"
    And the address holds that node's log key
    And the node "beta@" is marked current

  Scenario: The panel says how big the log is and whether it is complete
    Given a settled red run of the failing fixture
    And I open that run
    When I open the output of "beta@"
    Then the output header states a byte size
    And the output header does not say "incomplete"

  Scenario: A log longer than one page can be walked forwards and back
    Given a settled run of the fixture whose node prints five thousand lines
    And I open that run
    When I open the output of "noisy@"
    And I press "Read from the start"
    Then the page window starts at "0 B"
    And the output holds "noisy line 000001"
    When I press "Newer"
    Then the page window has moved forward
    And the output does not hold "noisy line 000001"
    When I press "Older"
    Then the page window starts at "0 B"
    And the output holds "noisy line 000001"
    And there should be no page errors

  Scenario: A retried node keeps both attempts, and either can be read
    Given a run of the fixture where one lane fails at once and its sibling sleeps
    And I open that run
    When I press "Retry" on "quick@"
    And the node "quick@" reaches "attempt 2"
    And I open the output of "quick@"
    Then the attempt picker offers "attempt 1" and "attempt 2"
    And "attempt 2" is the chosen attempt
    When I choose "attempt 1"
    Then the address names attempt 1
    And "attempt 1" is the chosen attempt
    And the output holds "BOOM: the quick lane failed"
