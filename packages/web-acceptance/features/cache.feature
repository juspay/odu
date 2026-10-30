Feature: The cache is a row of the board
  # The cache used to be a capability of the CI feature and invisible from the
  # page. It is a row now, and this feature grades the three things that makes
  # true: a push shows up WITHOUT a reload, a bucket page answers what a client
  # needs to trust it, and its paths can be read and narrowed.
  #
  # Every action here is a CONTROL. The arrange steps push from the CLI because
  # that is how a path gets into a bucket — a person with a `result` symlink on
  # a build box — and the board is then read the way a person would read it:
  # clicking, typing, tabbing.

  Scenario: A bucket pushed while the page is open appears without a reload
    Given I open the cache
    When a bucket with one path is pushed from the CLI
    Then a bucket row names it
    And that row says it holds 1 paths
    And that row shows a recent push
    And there should be no page errors

  Scenario: A bucket opens, and answers what a client has to trust
    Given a bucket with one path pushed from the CLI
    And I open the cache
    When I open that bucket
    Then the page shows its substituter URL
    And the page shows its public key
    And the page offers the netrc lines a Nix client needs
    And the pushed path is listed
    And there should be no page errors

  Scenario: The filter narrows a bucket's paths
    Given a bucket with one path pushed from the CLI
    When I open that bucket
    Then the pushed path is listed
    When I filter the paths by "nothing-matches-this"
    Then no path is listed
    And the page says nothing matches
    When I filter the paths by the pushed path's name
    Then the pushed path is listed
    And there should be no page errors

  Scenario: A bucket that does not exist is not a page error
    Given a bucket with one path pushed from the CLI
    When I open a bucket the cache does not have
    Then the page says that bucket is not there
    And there should be no page errors
