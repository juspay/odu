Feature: The board answers "what is my CI doing"
  # The view the whole service exists for. What is graded here is that a person
  # can CHOOSE a run without opening it, and that the three empty states stay
  # apart — "nothing yet" and "nothing matching" send somebody looking in very
  # different places.

  Scenario: A run carries the facts needed to choose it
    Given a settled red run of the failing fixture
    When I open the board
    Then a row names the fixture project
    And that row shows the run's short commit ref
    And that row shows a red "failed" outcome
    And that row shows "1 failing"
    And there should be no page errors

  Scenario: The filters narrow the board and announce which is pressed
    Given a settled red run of the failing fixture
    And I open the board
    Then the "All" filter is pressed
    When I press the "Active" filter
    Then the "Active" filter is pressed
    And the "All" filter is not pressed
    And that run is not listed
    When I press the "Needs attention" filter
    Then that run is listed

  Scenario: An empty filter says which kind of empty it is
    Given a settled red run of the failing fixture
    And I open the board
    When I press the "Active" filter
    Then the board reads "No runs match this filter"
    And the board does not read "No runs in the catalog yet"
