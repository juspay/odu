Feature: Every control is reachable from the keyboard

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
