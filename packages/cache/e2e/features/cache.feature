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

  # The board has two rows and ONE tab. What is graded here is that switching
  # rows does not switch off the ambient monitor: the counts are the runs', and
  # they must keep arriving while the cache is the row on screen.
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
    And the page offers the netrc lines a Nix client needs
    And the pushed path is listed
    And there should be no page errors

  Scenario: The filter narrows a bucket's paths
    # TWO paths, so this shows NARROWING rather than show-and-hide: one filter
    # leaves both, another leaves exactly one.
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

  # THE SUBSTITUTER URL IN A BROWSER. It used to render the board's Runs view —
  # the SPA shell at a path it was never routed for — because a bucket's page is
  # server-rendered and `/cache/<bucket>` matched no protocol file. It is the
  # cache row's page now, and a path under that prefix that names nothing is the
  # row's text 404, never the shell.
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

  # A PRIVATE BUCKET'S READER NEEDS A CREDENTIAL, so its page — and only its
  # page — carries the netrc block.
  Scenario: A private bucket's page carries the netrc block
    Given a bucket with one path pushed from the CLI
    When the CLI makes a private bucket and mints a read token
    And I open that bucket's page as its reader
    Then the page has the netrc block
    And there should be no page errors

  # A CONTROL FOR A ROW THAT IS NOT MOUNTED opens a subscription nothing
  # answers, and runs on every existing cache scenario. The daemon's roster is
  # the fact the page draws by.
  Scenario: A daemon without the tunnel row draws no Tunnel control
    Given I open the cache
    Then the board offers no Tunnel control
    And there should be no page errors

  Scenario: A bucket that does not exist is not a page error
    Given a bucket with one path pushed from the CLI
    When I open a bucket the cache does not have
    Then the page says that bucket is not there
    And there should be no page errors

  # THE PUSH API BEHIND A DOOR. Every scenario above runs against a loopback
  # daemon with no door, which is how the gate answering `/_odu/v1/…` with the
  # sign-in page reached a live pod unseen. A bucket token is the push's whole
  # credential: the CLI carries no session cookie, and must not need one.
  @signed-in:admin
  Scenario: A bucket token pushes through the door with no session
    When the CLI creates a bucket as this person
    And one path is pushed to it with a bucket token and no session
    Then the bucket serves that path's narinfo to the token
