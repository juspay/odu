Feature: Every control is reachable from the keyboard
  # Not "there is an aria attribute somewhere in the DOM" — these scenarios put
  # the focus ring where a person's Tab key would put it and press the keys a
  # person would press. The last scenario is the structural one: every control in
  # this app goes through one helper precisely so that keyboard access is a
  # property of the app rather than a checklist item per button.

  Scenario: The board's filters are operable by keyboard and announce which is pressed
    Given I open the board
    When I tab to the "Active" filter
    And I press Enter
    Then the "Active" filter is pressed
    And the "All" filter is not pressed

  Scenario: A run is opened without a mouse
    Given a settled red run of the failing fixture
    And I open the board
    When I tab to the first run row
    And I press Enter
    Then the address names a run

  # Nothing here is clicked and nothing is set programmatically past putting the
  # caret in the first field. The last Enter is the one that matters: it is
  # pressed inside a TEXT FIELD, which is the only action that goes through
  # HTML's implicit submission — the path that was dead while every control in
  # this app was hardcoded type="button". An Enter on the focused button instead
  # would pass either way and prove nothing.
  #
  # The --no-post detour is not ceremony. A fixture repo has no GitHub origin, so
  # a posting run is refused before it starts; ticking the box with Space is both
  # how a keyboard user would do it and a second control exercised for free.
  Scenario: The create form is filled and submitted from the keyboard alone
    Given a fixture checkout whose pipeline fails
    And I open the create form
    When I focus "Checkout" and type the fixture path
    And I press Tab and type the fixture HEAD
    And I tab to the "Do not post GitHub commit statuses (--no-post)" option
    And I press Space
    Then that option is ticked
    When I shift-tab back to the "Expected commit" field
    And I press Enter
    Then the address names a run
    And there should be no page errors

  Scenario: No control is a div with a click handler
    Given a settled red run of the failing fixture
    And I open the board
    Then every control on the page is a real button
    And every visible control can be reached by tabbing
