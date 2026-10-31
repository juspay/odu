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

  # The button is never greyed out: the empty name is SENT, and what the page
  # shows is the ROW's own refusal — the sentence asserted is the cache's.
  @signed-in:admin
  Scenario: An empty bucket name is refused by the row, in its words
    Given I open the cache
    When I press "Create bucket"
    Then the cache says "a bucket needs a name"
    And there should be no page errors

  @signed-in:admin
  Scenario: A bucket gets a name of its own from its page
    # THE NAME CHANGES WHAT THE PAGE SHOWS A CLIENT, and nothing else on this
    # page moved: the substituter URL, the nix.conf block and the netrc machine
    # are the domain, while the push block keeps the path the API addresses.
    Given a bucket created from the board
    When I name the bucket "cache.e2e.test"
    Then the page's substituter URL is "cache.e2e.test"
    And the page's netrc block names "cache.e2e.test"
    And the push block still names the bucket's path
    And there should be no page errors

  # A PUBLIC BUCKET'S FACTS NEED NO ACCOUNT, and that is a PROTOCOL read: the
  # anonymous CLI works before anybody signs in, and a cURL sees the key.
  @signed-in:admin
  Scenario: A public bucket's facts are read with no account
    Given the CLI creates a bucket as this person
    When the CLI reads the bucket's facts with no account
    Then it prints the bucket's public key
    And an anonymous HTTP GET of the bucket's page shows the key
    And there should be no page errors

  @signed-in:admin
  Scenario: A private bucket's facts need a reader
    Given I open the profile
    And I create a token named "cli"
    When the CLI creates a private bucket as this person
    And the CLI reads the bucket's facts with no account
    Then it is refused as private
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
    And the push block names the minted token
    And the minted token is listed as "write"
    When I revoke the minted token
    Then the minted token is listed as "revoked"
    And there should be no page errors

  @signed-in:admin
  Scenario: A token minted on the page carries an expiry
    # THE FORM'S DEFAULT IS NINETY DAYS and "never" is a visible choice, so a
    # web-minted token is not the one credential on this page that never ends.
    Given a bucket created from the board
    Then the token form defaults to 90 days
    When I mint a "write" token
    Then the minted token shows an expiry
    And there should be no page errors

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

  @signed-in:admin
  Scenario: An empty pin is refused by the row, in its words
    Given a bucket created from the board
    When I press "Pin closure"
    Then the cache says "a pin needs a name"
    And there should be no page errors

  # LOOPBACK: no door, so the person at this machine is its owner and the
  # row's rule for administration is the operator's root token. The page asks
  # for it once; a wrong one is the row's refusal, not the page's.
  Scenario: With no door, the root token typed once creates a bucket
    Given I open the cache
    When I type the root token
    And I name a new bucket
    And I press "Create bucket"
    Then the page opens that bucket
    And there should be no page errors

  Scenario: With no door, a wrong root token is the row's refusal
    Given I open the cache
    When I type a wrong root token
    And I name a new bucket
    And I press "Create bucket"
    Then the cache says "the root token does not match"
    And there should be no page errors
