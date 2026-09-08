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

  # One row per CHECKOUT is the default, because "what is my CI doing" is a
  # question about checkouts and a superseded run's verdict is history. What is
  # graded here is that the folded rows are ANNOUNCED rather than silently
  # dropped — a board that quietly hid a run would be worse than one that
  # listed forty.
  Scenario: History shows every run of a checkout
    Given a fresh settled red run of the failing fixture
    And I open that run
    When I press "Run again"
    Then a status reads "Started"
    When I press "← Runs"
    Then that row shows "1 earlier" in the age cell
    When I show the history
    Then the board lists two runs of the fixture project
    And there should be no page errors

  Scenario: An empty filter says which kind of empty it is
    Given a settled red run of the failing fixture
    And I open the board
    When I press the "Active" filter
    Then the board reads "No runs match this filter"
    And the board does not read "No runs in the catalog yet"
