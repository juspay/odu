Feature: A live run, its early failure, and its controls
  # The fixture is two parallel roots: one fails at once, the other sleeps for
  # two minutes. That shape is the point — every assertion below is about a run
  # that is STILL GOING, which is the only state in which "cancel this node" and
  # "retry this attempt" mean anything at all. The sleep is far longer than any
  # scenario's patience so an assertion can never pass because the sibling
  # happened to finish.
  #
  # Each scenario arranges its own run: these controls MUTATE, so sharing one
  # would make the suite's verdicts depend on the order cucumber picked.

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

  # THE DIALOG IS THE POINT. The whole-run cancel is the one control on this
  # page that costs the most when it is pressed by mistake — it throws away
  # every lane's work at once, it cannot be undone, and it sits one button away
  # from "Run again" — so it asks first. The lane and node cancels above stay
  # one click on purpose: they are scoped, and the run carries on around them.
  # The confirmation is named for the ACT rather than for its trigger, because
  # two buttons both reading "Cancel run" would be ambiguous to a person and
  # unaddressable to this suite.
  Scenario: Cancelling the whole run reports what it told the coordinator
    When I press "Cancel run"
    And I press "Yes, cancel it"
    Then a status reads "Told the coordinator to stop"
    And there should be no page errors
