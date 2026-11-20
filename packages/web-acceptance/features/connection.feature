Feature: The connection is drawn, never hidden

  Scenario: A dropped socket says so, keeps the last rows, and recovers
    Given a settled red run of the failing fixture
    And I open the board
    Then the wire reads "live"
    And a row names the fixture project
    When the browser goes offline
    Then the wire reads "reconnecting — showing the last thing the service said"
    And a row names the fixture project
    When the browser comes back online
    Then the wire reads "live"
    And a row names the fixture project
