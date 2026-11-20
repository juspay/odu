Feature: A daemon with no door keeps every run control

  Scenario: A loopback board starts a run
    Given a fixture checkout whose pipeline fails
    And I open the board
    When I press "New run"
    And I fill "Checkout" with the fixture path
    And I fill "Expected commit" with the fixture HEAD
    And I tick "Do not post GitHub commit statuses (--no-post)"
    And I press "Start run"
    Then the address names a run
    And there should be no page errors

  Scenario: A settled loopback run still offers its controls
    Given a settled red run of the failing fixture
    And I open that run
    Then the run page offers "Run again"
    And the run page offers "Retry"
    And there should be no page errors
