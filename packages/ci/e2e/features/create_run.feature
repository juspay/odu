Feature: Starting a run from the browser
  # Every scenario here TYPES into the real form and presses the real button.
  # The refusals are the feature: each one is a sentence the service wrote for a
  # person, and what is graded is that the browser shows it — with the recovery
  # — rather than clearing the form and going quiet.

  Scenario: The form starts a run and lands on it
    Given a fixture checkout whose pipeline fails
    And I open the board
    When I press "New run"
    And I fill "Checkout" with the fixture path
    And I fill "Expected commit" with the fixture HEAD
    And I tick "Do not post GitHub commit statuses (--no-post)"
    And I press "Start run"
    Then the address names a run
    And the run detail shows the node "alpha@"
    And there should be no page errors

  Scenario: A checkout that is not a repository is refused, visibly and in words
    Given I open the create form
    When I fill "Checkout" with "/definitely/not/a/repo"
    And I fill "Expected commit" with "0000000000000000000000000000000000000000"
    And I press "Start run"
    Then an alert reads "is not a git checkout"
    And the alert reads "never a relative one and never a cwd"
    And the "Checkout" field still holds "/definitely/not/a/repo"

  Scenario: A commit that moved on is refused, with the command that recovers
    Given a fixture checkout whose pipeline fails
    And I open the create form
    When I fill "Checkout" with the fixture path
    And I fill "Expected commit" with "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    And I press "Start run"
    Then an alert reads "the checkout moved since you read it"
    And the alert reads "Try: git -C"

  Scenario: A checkout that already has a live run is answered, not refused
    Given a fixture checkout that stays running
    And that checkout has a live run
    And I open the create form
    When I fill "Checkout" with the fixture path
    And I fill "Expected commit" with the fixture HEAD
    And I press "Start run"
    Then a status reads "already has a live run at"
    And there is no alert
    When I press "Open it"
    Then the address names the run that was already live

  Scenario: Ticking supersede takes the checkout
    Given a fixture checkout that stays running
    And that checkout has a live run
    And I open the create form
    When I fill "Checkout" with the fixture path
    And I fill "Expected commit" with the fixture HEAD
    And I tick "Do not post GitHub commit statuses (--no-post)"
    And I tick "Take the checkout from a run already live in it (--supersede)"
    And I press "Start run"
    Then the address names a run
    And the address does not name the run that was already live
