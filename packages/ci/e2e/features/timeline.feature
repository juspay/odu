Feature: One timeline, one scale

  Background:
    Given a run of the fixture with a settled, a running and a waiting lane
    And I open that run

  Scenario: Every node's track is the box the axis is drawn in
    Then the node "quick@" is ok
    And the node "slow@" is running
    And every node's timeline track is the same box as the axis
    And there should be no page errors
