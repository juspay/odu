Feature: The connection is drawn, never hidden
  # The page keeps showing the last thing the service said when the wire drops —
  # and SAYS SO. The failure this guards against is the opposite: stale rows that
  # still look live, which is how a person concludes their CI is quiet when in
  # fact nobody has heard from it in ten minutes.

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
