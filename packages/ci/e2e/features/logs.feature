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

  # THE CLOSING PAGE CARRIES UNREAD BYTES. A read is bounded, so a producer that
  # finishes after appending more than one page hands the follower a page that
  # says "this log can no longer grow" with output still behind it. Ending
  # there — which the browser and the TUI both did — throws away the end of the
  # log, which for a failure is the diagnosis. Nothing here navigates or pages:
  # the assertion is that the final marker arrives on its own.
  Scenario: A live log that bursts past one page and closes is drained to its last line
    Given a live run of the fixture whose node bursts and then stops
    And I open that run
    When I open the output of "burst@"
    Then the output holds "__BURST_BEGIN__"
    And the output holds "__BURST_END__"
    And there should be no page errors

  # AND THE FOLLOW SURVIVES LOSING THE WIRE. The loop used to exit on any read
  # error, and its effect is keyed on the log key — so a reader who dropped
  # their connection and got it back, without changing node, watched a frozen
  # pane while the header and the board recovered around them. The producer
  # keeps writing across the outage, so what is graded is that the missing bytes
  # arrive and arrive ONCE.
  Scenario: Losing the connection mid-log does not stop the follow
    Given a live run of the fixture whose node bursts and then stops
    And I open that run
    When I open the output of "burst@"
    And the output holds "__BURST_BEGIN__"
    And the browser goes offline
    And the node writes on while the browser is offline
    And the browser comes back online
    Then the output holds "__BURST_END__"
    And every line of the output appears exactly once
    And the wire reads "live"
    # NO "no page errors" here, and that is not an exemption. Taking the network
    # away makes the browser log a failed WebSocket connection — that IS the
    # outage this scenario arranges, reported by the browser rather than by odu.
    # `connection.feature` leaves the step off for the same reason. What is
    # asserted instead is that the wire came back, which is the fact that would
    # otherwise hide behind a tolerated error.
