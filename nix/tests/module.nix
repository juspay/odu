# THE VM TEST FOR `services.odu`, and the only place the whole story is one
# machine: a server with the module, an nginx in front of it, and a client with
# no substituters of its own that has never heard of odu.
#
# What it proves, in order:
#
#   * the unit starts as the `odu` user, with the state directory at 0700 and
#     the database at 0600 — the modes that make the signing keys a secret;
#   * `odu cache create` prints the PUBLIC url (`http://cache.test/cache/main`),
#     which is `$ODU_PUBLIC_ORIGIN` doing its job: the bound origin is loopback,
#     so without it the URL is one no client can reach;
#   * a token pushed over HTTP and a path built on the server lands in the
#     bucket, and the client substitutes it back through the proxy with the
#     bucket's own key;
#   * the board does NOT answer from outside — `/` is 404 and `/mcp` is not 200,
#     because the virtual host has no `location /`. That is the module's whole
#     security story and it is asserted, not asserted-in-a-comment.
#
# `cache.enableACME = false` because a VM has no certificate authority and no
# name to prove; the assertion is about ROUTES, and a plain-HTTP vhost tests the
# same routes.
{ self }:
{
  name = "odu-module";

  nodes.server = { config, pkgs, ... }: {
    imports = [ self.nixosModules.default ];

    services.odu = {
      enable = true;
      rootTokenFile = "/etc/odu-root-token";
      cache.domain = "cache.test";
      cache.enableACME = false;
    };

    # A test token. It is `environment.etc` rather than `LoadCredential`'s usual
    # secret file because a VM has no agenix and the module only needs a path.
    environment.etc."odu-root-token".text = "test-root-token";

    # The server builds the path it pushes, so it needs the flake-era CLI. A
    # real host has this for its own reasons; here it is the fixture's.
    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    networking.firewall.allowedTCPPorts = [ 80 ];
  };

  nodes.client = { pkgs, ... }: {
    # `/etc/hosts` is a read-only copy of the store in a NixOS VM, so the name
    # has to be mapped at EVAL time. The test driver numbers the VLAN by node
    # name in sorted order — `client` then `server`, so the server is .2 — and
    # the script asserts that below, so a machine added to this file breaks the
    # assertion instead of the `nix copy` four steps later.
    networking.extraHosts = "192.168.1.2 cache.test";
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      # No substituters: the point is that the only source is the cache under
      # test, reached through the proxy.
      substituters = [ ];
    };
  };

  # The server is 192.168.1.1 in this test's network; the client resolves the
  # domain there so the URL the module prints is the one the client uses.
  testScript = ''
    import json

    start_all()

    server.wait_for_unit("odu-web.service")
    server.wait_for_unit("nginx.service")

    server_ip = server.succeed("hostname -I | cut -d' ' -f1").strip()
    assert server_ip == "192.168.1.2", f"the driver moved the server to {server_ip}; fix nodes.client's extraHosts"
    assert "cache.test" in client.succeed("cat /etc/hosts")

    # ── the daemon is the service user, and its state is nobody else's ──────
    server.succeed("test \"$(systemctl show -p User --value odu-web)\" = odu")
    # The unit is `active` before the daemon has claimed its gate and opened the
    # database, so this waits for the FILE rather than for systemd's opinion.
    server.wait_until_succeeds("test -e /var/lib/odu/cache/cache.sqlite")
    server.succeed("stat -c '%a' /var/lib/odu | grep -qx 700")
    server.succeed("stat -c '%a' /var/lib/odu/cache/cache.sqlite | grep -qx 600")

    # ── the URL a bucket publishes is the PUBLIC one ────────────────────────
    # `ODU_PUBLIC_ORIGIN` is the module's doing; without it this URL is the
    # loopback address the daemon is bound to, which no client can reach.
    # The CLI reaches the daemon by ORIGIN, not by state directory — that is
    # what `$ODU_WEB_ORIGIN` is for, and it is how a person with a forward runs
    # these commands. `HOME` is set to the unit's so this is the same
    # environment the daemon has, rather than root's inherited through `runuser`.
    admin = (
        "runuser -u odu -- env ODU_ROOT_TOKEN=test-root-token"
        " ODU_WEB_ORIGIN=http://127.0.0.1:18440 HOME=/var/lib/odu"
    )
    odu = "${self.packages.x86_64-linux.odu}/bin/odu"
    created = json.loads(server.succeed(f"{admin} {odu} cache create main -o json"))
    assert created["url"] == "http://cache.test/cache/main", created["url"]
    key = created["publicKey"]
    assert key.startswith("main-1:"), key

    token = json.loads(
        server.succeed(f"{admin} {odu} cache token mint main --write -o json")
    )["token"]

    # ── a path on the server, pushed through the proxy ──────────────────────
    server.succeed("echo odu-module-test > /tmp/payload")
    path = server.succeed("nix store add-path /tmp/payload").strip()
    server.succeed(
        f"runuser -u odu -- env ODU_WEB_ORIGIN=http://127.0.0.1:18440"
        f" ODU_CACHE_TOKEN={token} {odu} cache push main {path}"
    )

    # ── the client substitutes it back, trusting only the bucket's key ──────
    copied = client.execute(
        f"nix copy --from http://cache.test/cache/main --to local?root=/tmp/sub"
        f" --option trusted-public-keys '{key}' {path}"
    )
    print(copied)
    assert copied[0] == 0, copied
    # Verify with the bucket's key, the same one the copy trusted: a path this
    # client did not build is untrusted until somebody it trusts signed it.
    client.succeed(
        f"NIX_REMOTE=local?root=/tmp/sub nix store verify {path}"
        f" --option trusted-public-keys '{key}'"
    )

    # ── and the board does not answer from outside ──────────────────────────
    # The virtual host has no `location /`: two cache paths and nothing else.
    root_code = client.succeed("curl -sS -o /dev/null -w '%{http_code}' http://cache.test/").strip()
    body = client.succeed("curl -sS http://cache.test/ | head -c 200")
    assert root_code == "404", f"the board answered {root_code} from outside: {body!r}"
    mcp_code = client.succeed("curl -sS -o /dev/null -w '%{http_code}' http://cache.test/mcp").strip()
    assert mcp_code != "200", f"/mcp answered {mcp_code} from outside"

    # ── administration works, and collection does not eat the bucket ────────
    server.succeed(f"{admin} {odu} cache stats")
    server.succeed(f"{admin} {odu} cache gc main")
  '';
}

