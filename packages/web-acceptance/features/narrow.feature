@narrow
Feature: A narrow viewport hides nothing

  Scenario: The board reflows rather than scrolling sideways
    Given a settled red run of the failing fixture
    And I open the board
    Then the page does not scroll sideways
    And every run row's scope and attention are within the viewport

  Scenario: The run detail stacks its two panels
    Given a settled red run of the failing fixture
    And I open that run
    Then the nodes and the output are stacked, not side by side
    And the page does not scroll sideways
