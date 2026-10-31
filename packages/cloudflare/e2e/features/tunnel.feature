Feature: A bucket's own name, through a tunnel
  # THE TUNNEL WORLD mounts the cloudflare row against a stub API and a
  # `cloudflared` that says it registered. Every step below is the PAGE a person
  # uses (the Domain field, the Tunnel panel) or the CLI's parity read; the
  # route's state is the row's own fact, not a log line.

  @tunnel
  Scenario: A bucket's name becomes a live route through the tunnel
    Given I open the cache
    When I type the root token
    And I name a new bucket
    And I press "Create bucket"
    And I name the bucket "cache.tunnel.test"
    When I open the tunnel
    Then the tunnel panel shows "cache.tunnel.test" as "live"
    When I open that bucket
    Then the bucket page shows the domain route as "live"
    And there should be no page errors

  @tunnel
  Scenario: Clearing the name removes the route and stops the connector
    Given I open the cache
    When I type the root token
    And I name a new bucket
    And I press "Create bucket"
    And I name the bucket "cache.tunnel.test"
    When I open the tunnel
    Then the tunnel panel shows "cache.tunnel.test" as "live"
    When I clear the bucket's domain
    Then the tunnel panel has no route for "cache.tunnel.test"
    And the tunnel connector is "stopped"
    And there should be no page errors

  @tunnel
  Scenario: A name in a zone the token cannot see is failed, with the reason
    Given I open the cache
    When I type the root token
    And I name a new bucket
    And I press "Create bucket"
    And I name the bucket "cache.unknown.test"
    When I open the tunnel
    Then the tunnel panel shows "cache.unknown.test" as "failed"
    And the tunnel panel's reason for "cache.unknown.test" names "no Cloudflare zone"
    And there should be no page errors

  @tunnel
  Scenario: odu cloudflare status reads the tunnel
    Given I open the cache
    When I type the root token
    And I name a new bucket
    And I press "Create bucket"
    And I name the bucket "cache.tunnel.test"
    When I open the tunnel
    Then the tunnel panel shows "cache.tunnel.test" as "live"
    And odu cloudflare status reports "cache.tunnel.test" as "live"
    And there should be no page errors
