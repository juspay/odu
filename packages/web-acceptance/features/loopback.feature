Feature: A daemon with no door keeps every run control
  # NO TAGS: this is the world the rest of the suite has always run in. With no
  # `ODU_GITHUB_*` the caller IS the local owner, so every floor is held and
  # every control is drawn. The regression this guards is a shell that decides
  # "nobody" for a daemon with no door — which silently removed Start run,
  # Retry, Run again and both cancels from the page.

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

  # NO "Cancel run" HERE. A finished run has nothing to stop, so the page draws
  # no cancel at any scope — the control a settled page used to offer could only
  # ever be refused. What this scenario still guards is the regression it was
  # written for: with no door, the caller is the local owner and the controls
  # that DO apply to a settled run are drawn. The live cancel, in this same
  # doorless world, is `packages/ci/e2e/features/live_run.feature`.
  Scenario: A settled loopback run still offers its controls
    Given a settled red run of the failing fixture
    And I open that run
    Then the run page offers "Run again"
    And the run page offers "Retry"
    And there should be no page errors
