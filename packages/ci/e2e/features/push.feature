# THE PUSH IS A STEP, not a footnote on a node.
#
# A recipe exits 0 and then its outputs go to the cache, which on a real run is
# the longer half of the two — a minute of upload under a minute of build. The
# page has to say so as work rather than as a result that appeared from nowhere,
# and the push's own account has to be readable without the recipe's output
# being adulterated by it.
#
# This scenario arranges a REAL push: a bucket on this daemon, a flake naming it
# the way a consumer's flake already does, and a recipe whose `result` link
# points at a two-line store path. Nothing is faked between the recipe exiting
# and the bytes landing, because the fact under test — that the push is its own
# step, with its own log — is a fact about that whole path.
Feature: A node's cache push is its own step

  Scenario: A node that pushed shows the push step, and its lines live in their own log
    Given a settled run whose node pushed to a bucket of this daemon
    And I open that run
    Then the run header says it pushes to that bucket
    And the run header totals what the run pushed
    And the node "warm@" shows its push step
    And the node "_ci-setup@" shows no push step
    When I open the output of "warm@"
    Then the output does not hold "[odu] pushing"
    And I note the log panel's size
    When I read the push log
    Then the output holds "[odu] pushing 1 result path"
    And the log panel names the push log at a size of its own
    And there should be no page errors
