Feature: The cache is a row of the board

  Scenario: A bucket pushed while the page is open appears without a reload
    Given I open the cache
    When a bucket with one path is pushed from the CLI
    Then a bucket row names it
    And that row says it holds 1 paths
    And that row shows a recent push
    And there should be no page errors

  Scenario: The tab keeps counting runs while the cache is on screen
    Given a settled red run of the failing fixture
    When I open the cache
    Then the tab counts the failing run
    And there should be no page errors

  Scenario: A bucket opens, and answers what a client has to trust
    Given a bucket with one path pushed from the CLI
    And I open the cache
    When I open that bucket
    Then the page shows its substituter URL
    And the page shows its public key
    And the page's nix.conf block carries no netrc lines
    And the pushed path is listed
    And that path says when it was last wanted
    And there should be no page errors

  Scenario: A path says which commit built it, and links the run that pushed it
    Given a bucket with one path pushed from the CLI with a run and a commit
    And I open the cache
    When I open that bucket
    Then the pushed path is listed
    And that path shows the commit it was built from, abbreviated
    And that path links to the run that pushed it
    And there should be no page errors

  Scenario: The filter narrows a bucket's paths
    Given a bucket with two paths pushed from the CLI
    When I open that bucket
    Then both pushed paths are listed
    When I filter the paths by the first path's name
    Then the first path is listed
    And the second path is not listed
    And there should be no page errors
    When I filter the paths by "nothing-matches-this"
    Then no path is listed
    And the page says nothing matches

  Scenario: Builds of one package are one row, and open to the versions
    Given a bucket with three builds of one package pushed from the CLI
    When I open that bucket
    Then that package is one row saying "3 versions"
    And the paths table holds 1 rows
    When I expand that package
    Then the paths table holds 3 version rows
    When I press "group by name"
    Then the paths table holds 3 rows
    And there should be no page errors

  Scenario: The table sorts by size, and says which way
    Given a bucket with a large and a small path pushed from the CLI
    When I open that bucket
    And I sort the paths by "size"
    Then the "large" path is first
    And the "size" column says it is sorted "descending"
    When I sort the paths by "size"
    Then the "small" path is first
    And the "size" column says it is sorted "ascending"
    And there should be no page errors

  Scenario: A bucket with more than one page offers the next twenty
    Given a bucket with 25 paths pushed from the CLI
    When I open that bucket
    Then the paths table holds 20 rows
    When I press "Show 20 more"
    Then the paths table holds 25 rows
    And there should be no page errors

  Scenario: The substituter URL in a browser is the bucket's page
    Given a bucket with one path pushed from the CLI
    When I open the bucket's substituter URL in a browser
    Then the page is the bucket's public page
    And the page has the four blocks a person pastes
    And the page carries no netrc block
    And the page links its substituter's health file
    And the page credits odu at "https://odu.kolu.dev/"
    And the page names the bucket's public key
    When I open a path under the cache that names nothing
    Then the cache answers it as its own 404
    And there should be no page errors

  Scenario: A private bucket's page carries the netrc block
    Given a bucket with one path pushed from the CLI
    When the API makes a private bucket and mints a read token
    And I open that bucket's page as its reader
    Then the page has the netrc block
    And there should be no page errors

  Scenario: A daemon without the tunnel row draws no Tunnel control
    Given I open the cache
    Then the board offers no Tunnel control
    And there should be no page errors

  Scenario: A bucket that does not exist is not a page error
    Given a bucket with one path pushed from the CLI
    When I open a bucket the cache does not have
    Then the page says that bucket is not there
    And there should be no page errors

  @signed-in:admin
  Scenario: A bucket token pushes through the door with no session
    When the API creates a bucket as this person
    And one path is pushed to it with a bucket token and no session
    Then the bucket serves that path's narinfo to the token
