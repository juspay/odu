Feature: Retrying a run that has already finished

  Scenario: odu chooses a linked replay, and the browser reports which it got
    Given a fresh settled red run of the failing fixture
    And I open that run
    When I press "Retry" on "beta@"
    Then a status reads "This run had finished, so odu started a linked replay"
    When I press "All runs"
    And I show the history
    Then the board lists two runs of the fixture project
    When I open the run on the board that is not this one
    Then the header reads "replay of"
    And there should be no page errors

  Scenario: Run again starts a new run at the same commit
    Given a fresh settled red run of the failing fixture
    And I open that run
    When I press "Run again"
    Then a status reads "Started"
