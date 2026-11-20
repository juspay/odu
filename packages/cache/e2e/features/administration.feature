Feature: An admin administers the cache from the board

  @signed-in:admin
  Scenario: An empty bucket name is refused by the row, in its words
    Given I open the cache
    When I open the new bucket form
    And I press "Create bucket"
    Then the cache says "a bucket needs a name"
    And there should be no page errors

  @signed-in:admin
  Scenario: A bucket gets a name of its own from its page
    Given a bucket created from the board
    When I name the bucket "cache.e2e.test"
    Then the page's substituter URL is "cache.e2e.test"
    And the domain answer says "Point its DNS record here."
    And the push block names the same cache the nix.conf block does
    And there should be no page errors

  @signed-in:admin
  Scenario: A public bucket's facts are read with no account
    Given the API creates a bucket as this person
    When the CLI reads the bucket's facts with no account
    Then it prints the bucket's public key
    And an anonymous HTTP GET of the bucket's page shows the key
    And there should be no page errors

  @signed-in:admin
  Scenario: A private bucket's facts need a reader
    Given I open the profile
    And I create a token named "cli"
    When the API creates a private bucket as this person
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
    And the cache says "objects on local"
    And there should be no page errors

  Scenario: A bucket is moved to another declared store from its page
    Given a daemon that declares a second store
    And a bucket created from the board
    And I mint a "write" token
    When a path is pushed with that token from the CLI
    Then the bucket's facts say "objects on local"
    And the move offers the store "gw"
    When I move the bucket to "gw"
    Then the bucket's facts say "objects on gw"
    And the bucket's facts say "reads served by odu"
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
    Given a bucket created from the board
    Then the token form defaults to 90 days
    When I mint a "write" token
    Then the minted token shows an expiry
    And there should be no page errors

  Scenario: A bucket is told how long to keep a path, and says the number back
    Given a bucket created from the board
    Then the retention form defaults to 90 days
    When I set the retention to "7" days
    Then the cache says "now keeps a path 7 days after the last time anything wanted it"
    And the bucket's facts say "7d retention"
    And there should be no page errors

  Scenario: A pin says what it holds, and unpinning gives the path back to retention
    Given a bucket created from the board
    And I mint a "write" token
    When a path is pushed with that token from the CLI
    And I open the pins
    And I pin that path as "release"
    Then the cache says "Pinned release"
    When I expand what the pin "release" holds
    Then the pin "release" is listed holding that path
    When I unpin "release"
    Then the cache says "Unpinned release"
    And the pin list says nothing is pinned
    And there should be no page errors

  Scenario: A pin of a big closure is one row, and its roots are a click away
    Given a bucket created from the board
    And I mint a "write" token
    When twelve paths are pushed with that token from the CLI
    And I open the pins
    And I pin every pushed path as "release"
    Then the cache says "Pinned release"
    And the cache says "12 paths in its closure"
    And the pin "release" keeps its roots folded away
    When I expand what the pin "release" holds
    Then the pin "release" shows its roots
    And the pin "release" renders 10 store paths
    When I press "show all 12"
    Then the pin "release" renders 12 store paths
    And the pin "release" is listed holding that path
    And there should be no page errors

  Scenario: A bucket is deleted from its page, and stops serving what it held
    Given a bucket created from the board
    And I mint a "write" token
    When a path is pushed with that token from the CLI
    Then the bucket serves that path's narinfo to the token
    And the delete button is disabled until the name is typed
    When I type the bucket's name to confirm
    And I press "Delete bucket"
    Then the page returns to the cache list
    And that bucket is no longer listed
    And the bucket's narinfo answers 404
    And there should be no page errors

  Scenario: A dry run names the next collection, which keeps the pin and takes the rest
    Given a bucket created from the board
    And I mint a "write" token
    And two paths are pushed with that token from the CLI
    And I open the pins
    And I pin the first path as "release"
    Then the cache says "Pinned release"
    When I set the retention to "0" days
    Then the cache says "now keeps only what a reference or a pin holds"
    When I press "Dry run"
    Then the dry run says "would take 1 path"
    And the dry run names the unpinned path
    And the dry run does not name the pinned path
    When I press "Run GC"
    Then the cache says "Collected: evicted 1 path"
    And the dry run says "would take nothing here"
    Then the bucket's facts say "1 paths"
    When I open the paths
    And I press "refresh paths"
    Then one path is listed
    And there should be no page errors

  Scenario: The dry run asks at a retention the bucket does not have, and keeps it
    Given a bucket created from the board
    And I mint a "write" token
    And two paths are pushed with that token from the CLI
    And I open the pins
    And I pin the first path as "release"
    Then the cache says "Pinned release"
    When I set the dry run retention to "0" days
    And I press "Dry run at 0 days"
    Then the dry run says "At 0 days' retention"
    And the dry run says "would take 1 path"
    And the dry run names the unpinned path
    And the dry run does not name the pinned path
    And the bucket's facts say "90d retention"
    When I press "Run GC"
    Then the cache says "Collected: evicted 0 paths"
    And the bucket's facts say "90d retention"
    And there should be no page errors

  Scenario: Each path says what keeps it, and when it leaves
    Given a bucket created from the board
    And I mint a "write" token
    And two paths are pushed with that token from the CLI
    And I open the pins
    And I pin the first path as "release"
    Then the cache says "Pinned release"
    When I open the paths
    And I press "refresh paths"
    Then the first path is kept by "pin release"
    And the second path is kept by retention, with a day it leaves
    When I set the retention to "0" days
    Then the cache says "now keeps only what a reference or a pin holds"
    Then the second path is kept by "nothing · next collection"
    And the first path is kept by "pin release"
    And there should be no page errors

  @signed-in:admin
  Scenario: An empty pin is refused by the row, in its words
    Given a bucket created from the board
    When I open the pins
    And I press "Pin closure"
    Then the cache says "a pin needs a name"
    And there should be no page errors

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
