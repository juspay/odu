Feature: Retrying a run that has already finished
  # Which KIND of retry happens is odu's decision, not the browser's: a live
  # coordinator gets a new attempt, a finished run gets a LINKED REPLAY. The
  # browser offers one button and reports which it got, because a page that
  # offered two would be asking a person to call a fact they cannot see.

  Scenario: odu chooses a linked replay, and the browser reports which it got
    Given a fresh settled red run of the failing fixture
    And I open that run
    When I press "Retry" on "beta@"
    Then a status reads "This run had finished, so odu started a linked replay"
    When I press "← Runs"
    Then the board lists two runs of the fixture project
    When I open the run on the board that is not this one
    Then the header reads "replay of"
    And there should be no page errors

  Scenario: Run again starts a new run at the same commit
    Given a fresh settled red run of the failing fixture
    And I open that run
    When I press "Run again"
    Then a status reads "Started"
