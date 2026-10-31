Feature: One timeline, one scale
  # A Gantt is a set of bars that share a scale, and the share is GEOMETRIC: if
  # two rows' tracks are different boxes, `left: 50%` on one is a different
  # instant from `left: 50%` on the other and the axis above them labels
  # neither. The track used to be sized inside the row's button, beside a
  # controls cell that is empty while a node waits, one button wide while it
  # runs and another width again once it has stopped — so this fixture is one
  # that holds all three at once, and the assertion is bounding boxes.

  Background:
    Given a run of the fixture with a settled, a running and a waiting lane
    And I open that run

  Scenario: Every node's track is the box the axis is drawn in
    Then the node "quick@" is ok
    And the node "slow@" is running
    And every node's timeline track is the same box as the axis
    And there should be no page errors
