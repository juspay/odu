Feature: An admin administers the cache from the board
  # The board does everything `odu cache` does. Each scenario here is one verb
  # of the cache row, reached through its control on the page — create (with
  # the upstream switch), token mint / list / revoke, pin, GC and stats — and
  # the one arrange step that leaves the page (a push) uses the token the page
  # minted, which is the proof that the token is real.
  #
  # @signed-in:admin: the row's floor for administration, on a daemon with a
  # door. A member is drawn none of these controls (auth.feature) and the row
  # refuses the CLI's call on its own.

  @signed-in:admin
  Scenario: An empty bucket name is refused on click, in words
    Given I open the cache
    When I press "Create bucket"
    Then the cache says "a bucket needs a name"
    And there should be no page errors

  @signed-in:admin
  Scenario: A bucket is created from the board with the upstream switch off
    Given I open the cache
    When I name a new bucket
    And I untick "Skip upstream paths"
    And I press "Create bucket"
    Then the page opens that bucket
    And the cache says "no upstream filter"
    And there should be no page errors

  @signed-in:admin
  Scenario: A token is minted, listed and revoked from a bucket page
    Given a bucket created from the board
    When I mint a "write" token
    Then the page shows the cache token once
    And the minted token is listed as "write"
    When I revoke the minted token
    Then the minted token is listed as "revoked"
    And there should be no page errors

  @signed-in:admin
  Scenario: A path pushed with a page-minted token is pinned, collected and counted
    Given a bucket created from the board
    And I mint a "write" token
    When a path is pushed with that token from the CLI
    And I pin that path as "release"
    Then the cache says "Pinned release"
    When I press "Run GC"
    Then the cache says "Collected: evicted"
    When I press "refresh stats"
    Then the stats say "1 paths"
    And there should be no page errors
