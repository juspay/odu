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
#   * a bucket on an S3 STORE — a versitygw on the same machine, declared in
#     `cache.stores` — takes a push into the S3 bucket (not the local disk)
#     and the client substitutes it back through the same proxy;
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
      # A BUCKET'S OWN NAME, with its own vhost: `main.test` answers the Nix
      # protocol at `/`, and the daemon decides which bucket from the `Host`.
      cache.bucketDomains = [ "main.test" ];
      cache.enableACME = false;
      # AN S3 STORE, on this machine: versitygw over a directory (below). The
      # credentials file is a systemd credential, exactly as a real R2 key.
      cache.stores.s3 = {
        endpoint = "http://127.0.0.1:7070";
        bucket = "odu-objects";
        region = "us-east-1";
        credentialsFile = "/etc/odu-s3-credentials";
      };
    };

    environment.etc."odu-s3-credentials".text = ''
      AWS_ACCESS_KEY_ID=odu
      AWS_SECRET_ACCESS_KEY=odu-s3-secret
    '';

    # THE S3 SERVICE the store points at: a real gateway (signed requests,
    # conditional writes, multipart, ranges) over a plain directory. The test
    # creates its bucket before the first push.
    systemd.services.versitygw = {
      wantedBy = [ "multi-user.target" ];
      before = [ "odu-web.service" ];
      serviceConfig = {
        StateDirectory = "versitygw";
        ExecStart =
          "${pkgs.versitygw}/bin/versitygw --access odu --secret odu-s3-secret"
          + " --port 127.0.0.1:7070 --quiet posix /var/lib/versitygw";
      };
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
    # name in sorted order — `client`, `server`, `zdoor` — and the script
    # asserts that below, so a machine added to this file breaks the assertion
    # instead of the `nix copy` four steps later.
    # TWO LINES, not one: `/etc/hosts` is `IP name [aliases…]`, so the one-line
    # form made `door.test` an ALIAS of 192.168.1.2 — the loopback machine —
    # and every door assertion then read nginx's 404 from the wrong vhost.
    networking.extraHosts = "192.168.1.2 cache.test main.test\n192.168.1.3 door.test";
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      # No substituters: the point is that the only source is the cache under
      # test, reached through the proxy.
      substituters = [ ];
    };
  };

  # THE SAME MACHINE, IN SERVER MODE — a second node rather than a second
  # assertion on the first, because the two shapes are exclusive: a daemon with
  # a door answers `/` with the sign-in page, and the loopback node's assertions
  # are that it answers 404.
  #
  # Named `zdoor` so the driver's sorted numbering leaves `server` at .2; the
  # assertion above is what notices if a node is inserted alphabetically.
  nodes.zdoor = { config, pkgs, ... }: {
    imports = [ self.nixosModules.default ];

    services.odu = {
      enable = true;
      rootTokenFile = "/etc/odu-root-token";
      cache.domain = "door.test";
      cache.enableACME = false;
      github = {
        clientId = "test-client-id";
        clientSecretFile = "/etc/odu-github-secret";
        allow = [ "org:juspay" ];
      };
    };

    environment.etc."odu-root-token".text = "test-root-token";
    environment.etc."odu-github-secret".text = "test-client-secret";

    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    networking.firewall.allowedTCPPorts = [ 80 ];
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
    # The door is a DIFFERENT machine, and the name has to say so: `extraHosts`
    # is one `IP name [aliases…]` per line, and a shared line made door.test an
    # alias of the loopback node — which answered 404 from the wrong vhost.
    assert client.succeed("getent hosts door.test").split()[0] == "192.168.1.3"

    # ── the daemon is the service user, and its state is nobody else's ──────
    server.succeed("test \"$(systemctl show -p User --value odu-web)\" = odu")
    # The unit is `active` before the daemon has claimed its gate and opened the
    # database, and the MODES are set after the FILE exists: `-wal` is created by
    # the first write, so the chmod follows the migrations. Wait for the
    # invariant, not for the file — waiting for `test -e` and then asserting
    # raced the chmod on a loaded CI lane, and passed locally, which is the
    # wrong way round. A mode that is wrong for good never settles, so this
    # still fails; it just fails on the fact rather than on the timing.
    server.succeed("stat -c '%a' /var/lib/odu | grep -qx 700")
    server.wait_until_succeeds(
        "stat -c '%a' /var/lib/odu/cache/cache.sqlite 2>/dev/null | grep -qx 600"
    )

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

    # ── THE READ CACHE WAS EARNED, not assumed ─────────────────────────────
    # The proxy caches a NAR and NOT its narinfo: the second GET of the same
    # object is `HIT`, which is the whole point of the module's `proxy_cache`.
    nar_file = client.succeed(
        "curl -sS http://cache.test/cache/main/%s.narinfo"
        " | sed -n 's|^URL: nar/||p'"
        % path.split("/")[-1][:32]
    ).strip()
    first = client.succeed(
        f"curl -sS -D - -o /dev/null http://cache.test/cache/main/nar/{nar_file}"
    )
    assert "X-Cache-Status: MISS" in first, first
    second = client.succeed(
        f"curl -sS -D - -o /dev/null http://cache.test/cache/main/nar/{nar_file}"
    )
    assert "X-Cache-Status: HIT" in second, second

    # ── A PRIVATE BUCKET IS NOT IN THE SHARED NAR CACHE ────────────────────
    # A request that carries a credential bypasses the cache and is never
    # stored (`proxy_cache_bypass`/`proxy_no_cache`), and the daemon says
    # `Cache-Control: private, no-store` besides. An anonymous fetch of the
    # same NAR must be refused, and must not be a HIT.
    server.succeed(f"{admin} {odu} cache create secret --private")
    secret_token = json.loads(
        server.succeed(f"{admin} {odu} cache token mint secret --write -o json")
    )["token"]
    server.succeed(
        f"runuser -u odu -- env ODU_WEB_ORIGIN=http://127.0.0.1:18440"
        f" ODU_CACHE_TOKEN={secret_token} {odu} cache push secret {path}"
    )
    secret_file = client.succeed(
        "curl -sS -H 'Authorization: Bearer %s'"
        " http://cache.test/cache/secret/%s.narinfo"
        " | sed -n 's|^URL: nar/||p'"
        % (secret_token, path.split("/")[-1][:32])
    ).strip()
    authorized = client.succeed(
        f"curl -sS -D - -o /dev/null -H 'Authorization: Bearer {secret_token}'"
        f" http://cache.test/cache/secret/nar/{secret_file}"
    )
    assert "Cache-Control: private, no-store" in authorized.lower() or "cache-control: private, no-store" in authorized.lower(), authorized
    anonymous = client.succeed(
        f"curl -sS -D - -o /dev/null http://cache.test/cache/secret/nar/{secret_file}"
    )
    assert "X-Cache-Status: HIT" not in anonymous, anonymous
    anon_code = client.succeed(
        f"curl -sS -o /dev/null -w '%{{http_code}}'"
        f" http://cache.test/cache/secret/nar/{secret_file}"
    ).strip()
    assert anon_code == "404", f"a private NAR answered {anon_code} anonymously"

    # ── A BUCKET'S OWN NAME ─────────────────────────────────────────────────
    # The name is a fact of the bucket; nginx needs a vhost for it (eval time),
    # and the daemon answers by `Host` — no rewrite, no bucket in the path.
    server.succeed(f"{admin} {odu} cache domain main main.test")
    info = client.succeed("curl -sS http://main.test/nix-cache-info")
    assert "WantMassQuery: 1" in info, info

    # THE NAME IS THE BUCKET'S ONLY. `/` is its page; the board, `/mcp` and
    # the door's own paths never answer there; another bucket's path is the
    # cache row's 404.
    public_page = client.succeed("curl -sS http://main.test/")
    assert "extra-substituters" in public_page, public_page[:300]
    assert 'aria-label="board rows"' not in public_page, "the board answered a bucket name"
    for outside in ["/mcp", "/auth/github", "/rpc/ws", "/assets/app.js", "/cache/other"]:
        code = client.succeed(
            f"curl -sS -o /dev/null -w '%{{http_code}}' http://main.test{outside}"
        ).strip()
        assert code == "404", f"{outside} answered {code} on a bucket name"

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

    # AND THE SAME PATH THROUGH THE BUCKET'S OWN NAME, at the root of it: the
    # made-up address is the one `odu cache use` prints now.
    by_name = client.execute(
        f"nix copy --from http://main.test --to local?root=/tmp/sub-name"
        f" --option trusted-public-keys '{key}' {path}"
    )
    print(by_name)
    assert by_name[0] == 0, by_name
    client.succeed(
        f"NIX_REMOTE=local?root=/tmp/sub-name nix store verify {path}"
        f" --option trusted-public-keys '{key}'"
    )

    # ── and the board does not answer from outside ──────────────────────────
    # The virtual host has no `location /`: two cache paths and nothing else.
    root_code = client.succeed("curl -sS -o /dev/null -w '%{http_code}' http://cache.test/").strip()
    body = client.succeed("curl -sS http://cache.test/ | head -c 200")
    assert root_code == "404", f"the board answered {root_code} from outside: {body!r}"
    mcp_code = client.succeed("curl -sS -o /dev/null -w '%{http_code}' http://cache.test/mcp").strip()
    assert mcp_code != "200", f"/mcp answered {mcp_code} from outside"

    # ── A BUCKET ON S3: pushed into the S3 bucket, served the same way ──────
    server.wait_for_unit("versitygw.service")
    server.wait_until_succeeds("curl -sS -o /dev/null http://127.0.0.1:7070/")
    s3 = "--aws-sigv4 aws:amz:us-east-1:s3 --user odu:odu-s3-secret"
    server.succeed(f"curl -sSf {s3} -X PUT http://127.0.0.1:7070/odu-objects")
    far = json.loads(server.succeed(f"{admin} {odu} cache create far --store s3 -o json"))
    assert far["store"] == "s3", far
    far_key = far["publicKey"]
    far_token = json.loads(
        server.succeed(f"{admin} {odu} cache token mint far --write -o json")
    )["token"]
    server.succeed(
        f"runuser -u odu -- env ODU_WEB_ORIGIN=http://127.0.0.1:18440"
        f" ODU_CACHE_TOKEN={far_token} {odu} cache push far {path}"
    )
    # THE BYTES ARE IN THE S3 BUCKET, under the odu bucket's prefix — and not
    # on the daemon's disk.
    listed = server.succeed(f"curl -sSf {s3} 'http://127.0.0.1:7070/odu-objects?list-type=2&prefix=far/'")
    assert "<Key>far/nar/" in listed, listed
    server.fail("ls /var/lib/odu/cache/objects/far")
    # A RANGE, answered from S3 through the same route.
    far_file = client.succeed(
        "curl -sS http://cache.test/cache/far/%s.narinfo | sed -n 's|^URL: nar/||p'"
        % path.split("/")[-1][:32]
    ).strip()
    ranged = server.succeed(
        f"curl -sS -D - -o /dev/null -H 'Range: bytes=0-3'"
        f" http://127.0.0.1:18440/cache/far/nar/{far_file}"
    )
    assert "206 partial content" in ranged.lower() and "content-length: 4" in ranged.lower(), ranged
    # AND THE CLIENT SUBSTITUTES IT, trusting only that bucket's key.
    from_s3 = client.execute(
        f"nix copy --from http://cache.test/cache/far --to local?root=/tmp/sub-s3"
        f" --option trusted-public-keys '{far_key}' {path}"
    )
    print(from_s3)
    assert from_s3[0] == 0, from_s3
    client.succeed(
        f"NIX_REMOTE=local?root=/tmp/sub-s3 nix store verify {path}"
        f" --option trusted-public-keys '{far_key}'"
    )

    # ── administration works, and collection does not eat the bucket ────────
    server.succeed(f"{admin} {odu} cache stats")
    server.succeed(f"{admin} {odu} cache gc main")

    # ── the OTHER shape: a daemon with a door ───────────────────────────────
    zdoor.wait_for_unit("odu-web.service")
    zdoor.wait_for_unit("nginx.service")
    zdoor.succeed(
        "runuser -u odu -- env ODU_ROOT_TOKEN=test-root-token"
        " ODU_WEB_ORIGIN=http://127.0.0.1:18440 HOME=/var/lib/odu"
        f" {odu} auth grant srid owner"
    )

    # ANONYMOUS `GET /` IS THE SIGN-IN PAGE, not the board and not nginx — and
    # so is EVERY path the shell's catch-all would answer: the gate no longer
    # keeps its own list of shell paths, so a typo is the sign-in page too.
    root = client.succeed("curl -sS http://door.test/")
    assert "Sign in to odu" in root, root[:400]
    assert "Sign in with GitHub" in root, root[:400]
    stray = client.succeed("curl -sS http://door.test/no-such-page")
    assert "Sign in to odu" in stray, stray[:400]

    # `/mcp` WITHOUT A BEARER IS 401 — the door's second lock, refused before
    # the adapter is entered.
    mcp_door = client.succeed(
        "curl -sS -o /dev/null -w '%{http_code}' -X POST"
        " -H 'content-type: application/json' -H 'origin: http://door.test'"
        " -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}'"
        " http://door.test/mcp"
    ).strip()
    assert mcp_door == "401", f"/mcp answered {mcp_door} without a token"

    # AND THE CACHE PROTOCOL IS STILL PROXIED. A bucket nobody created answers
    # the DAEMON's empty 404 rather than nginx's HTML page, which is what says
    # the route reached odu rather than the vhost's own handler.
    # TRAILING newlines off, then split: `succeed` hands a command's output back
    # with one on the end, so splitting first read the code as "" — an assertion
    # that never ran until this test could reach it. Only the END is trimmed:
    # the 404 body is EMPTY, so the code sits after the very first newline.
    answer = client.succeed(
        "curl -sS -w '\\n%{http_code}' http://door.test/cache/main/nix-cache-info"
    ).rstrip("\n")
    cache_body, cache_code = answer.rsplit("\n", 1)
    assert cache_code.strip() == "404", cache_code
    assert "<html" not in cache_body.lower(), cache_body[:200]

    # AND SO IS THE PUSH API. The gate once claimed `/cache/*` but not
    # `/_odu/v1/*`, so an anonymous push met the sign-in page (200, HTML) and
    # `odu cache push` failed to parse it. The daemon's own answer for a bucket
    # nobody created is an empty 404 — anything but the shell.
    answer = client.succeed(
        "curl -sS -w '\\n%{http_code}' -X POST -H 'content-type: application/json'"
        " -d '{\"paths\":[]}' http://door.test/_odu/v1/buckets/main/missing"
    ).rstrip("\n")
    push_body, push_code = answer.rsplit("\n", 1)
    assert push_code.strip() == "404", f"the push API answered {push_code}: {push_body[:200]!r}"
    assert "<html" not in push_body.lower(), push_body[:200]
  '';
}

