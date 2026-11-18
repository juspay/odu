# THE VM TEST FOR `services.odu`, and the only place the whole story is one
# machine: a server with the module, an nginx in front of it, a client with
# no substituters of its own that has never heard of odu, and a team member's
# machine where an ordinary user goes through the Nix daemon.
#
# What it proves, in order:
#
#   * the unit starts as the `odu` user, with the state directory at 0700 and
#     the database at 0600 — the modes that make the signing keys a secret;
#   * `odu surface cache bucket_create` answers the PUBLIC url
#     (`http://cache.test/cache/main`), which is `$ODU_PUBLIC_ORIGIN` doing its
#     job: the bound origin is loopback, so without it the URL is one no client
#     can reach;
#   * a token pushed over HTTP and a path built on the server lands in the
#     bucket, and the client substitutes it back through the proxy with the
#     bucket's own key;
#   * an ORDINARY user on a machine with the Nix daemon fetches a build output
#     from the bucket only when the address AND the key are in the MACHINE's
#     configuration — her own command line and her own `nix.conf` are
#     ignored, and the address without the key is refused as unsigned — and
#     pushes a build of her own with `odu cache login` and `odu cache push`;
#   * a bucket on an S3 STORE — a versitygw on the same machine, declared in
#     `cache.stores` — takes a push into the S3 bucket (not the local disk)
#     and the client substitutes it back through the same proxy;
#   * a NAR on that S3 store is a 307 to a PRESIGNED url on the gateway, not
#     bytes odu copied: the redirect is asserted as itself, and then followed
#     by a real `nix copy`;
#   * and the headline of PLAN 2.8 — a public bucket on a store with a
#     `publicUrl` is read with the daemon STOPPED, because its narinfos,
#     its `nix-cache-info` and its NARs are objects the store serves itself;
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
      #
      # The endpoint is a NAME, not loopback: odu hands clients presigned URLs
      # built from it, and `127.0.0.1` on the client is the client. `publicUrl`
      # is the store's own name for readers — the nginx vhost below, standing
      # in for an R2 custom domain bound to the R2 bucket.
      cache.stores.s3 = {
        endpoint = "http://gateway.test:7070";
        bucket = "odu-objects";
        region = "us-east-1";
        publicUrl = "http://public.test";
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
          + " --port 0.0.0.0:7070 --quiet posix /var/lib/versitygw";
      };
    };

    # A test token. It is `environment.etc` rather than `LoadCredential`'s usual
    # secret file because a VM has no agenix and the module only needs a path.
    environment.etc."odu-root-token".text = "test-root-token";

    # WHAT THE WORLD READS THE STORE FROM. `publicUrl` names this vhost, and
    # odu appends `/<bucket>/<key>`; path-style S3 puts the S3 bucket's name
    # first, so the vhost's root IS the `odu-objects/` prefix and
    # `http://public.test/far/<hash>.narinfo` lands on the object the push
    # wrote. Nothing here is odu: that is the point of the test below.
    services.nginx.virtualHosts."public.test".locations."/".proxyPass =
      "http://127.0.0.1:7070/odu-objects/";

    # The gateway and the store's public name both answer on this machine, and
    # the DAEMON resolves the first one when it signs a URL for a client.
    networking.extraHosts = "192.168.1.2 gateway.test\n192.168.1.2 public.test";

    # The server builds the path it pushes, so it needs the flake-era CLI. A
    # real host has this for its own reasons; here it is the fixture's.
    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    # 7070 is the gateway: a presigned URL is followed by the CLIENT, so the
    # port the signature names has to be reachable from off the machine.
    networking.firewall.allowedTCPPorts = [ 80 7070 ];
  };

  nodes.client = { pkgs, ... }: {
    # `/etc/hosts` is a read-only copy of the store in a NixOS VM, so the name
    # has to be mapped at EVAL time. The test driver numbers the VLAN by node
    # name in sorted order — `client`, `server`, `zdoor`, `zlaptop` — and the
    # script asserts that below, so a machine added to this file breaks the
    # assertion instead of the `nix copy` four steps later.
    # TWO LINES, not one: `/etc/hosts` is `IP name [aliases…]`, so the one-line
    # form made `door.test` an ALIAS of 192.168.1.2 — the loopback machine —
    # and every door assertion then read nginx's 404 from the wrong vhost.
    networking.extraHosts = ''
      192.168.1.2 cache.test main.test
      192.168.1.2 gateway.test
      192.168.1.2 public.test
      192.168.1.3 door.test
    '';
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

  # A TEAM MEMBER'S MACHINE: NixOS with the Nix daemon, one ordinary user, and
  # no cache of its own. What it shows is the rule an ordinary user lives by —
  # the daemon takes `substituters` and `trusted-public-keys` only from the
  # MACHINE's configuration, and ignores the user's own — against the bucket
  # this file's `server` publishes.
  #
  # The bucket's key is minted while the test runs, so the machine's
  # `nix.conf` cannot hold it at eval time. It includes a file instead, which
  # the script writes and then restarts the daemon to read: the same two lines
  # a person adds to `/etc/nix/nix.conf`, in a file the store does not own.
  # `!include` skips a file that is not there yet, so until then the machine
  # has no cache at all.
  #
  # Named `zlaptop` so it sorts LAST: the driver numbers machines by sorted
  # name, and every other machine keeps the address `extraHosts` gives it.
  nodes.zlaptop = { lib, ... }: {
    networking.extraHosts = ''
      192.168.1.2 cache.test main.test
    '';
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      # Nothing but the bucket, once the script names it. FORCED, because
      # NixOS adds cache.nixos.org to this list after whatever is set here, and
      # a VM that cannot reach it retries it on every fetch.
      substituters = lib.mkForce [ ];
    };
    nix.extraOptions = ''
      !include /etc/nix/odu-bucket.conf
    '';
    # NOT in `trusted-users`, which is `root` alone by default — the whole
    # point of this machine.
    users.users.alice.isNormalUser = true;
    environment.systemPackages = [ self.packages.x86_64-linux.odu ];
  };

  # The server is 192.168.1.1 in this test's network; the client resolves the
  # domain there so the URL the module prints is the one the client uses.
  testScript = ''
    import json
    import shlex

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
    # The API face reaches the daemon by ORIGIN, not by state directory — that
    # is what `$ODU_WEB_ORIGIN` is for, and it is how a person with a forward
    # runs these commands. `HOME` is set to the unit's so this is the same
    # environment the daemon has, rather than root's inherited through
    # `runuser`.
    admin = (
        "runuser -u odu -- env"
        " ODU_WEB_ORIGIN=http://127.0.0.1:18440 HOME=/var/lib/odu"
    )
    odu = "${self.packages.x86_64-linux.odu}/bin/odu"
    ROOT_TOKEN = "test-root-token"

    def surface(machine, env, row, verb, payload):
        """One administrative verb through `odu surface <row> <verb>`.

        The root token is a FIELD of the input, never an environment side
        channel; `--json` asks for the verb's whole answer. Exit 0 is an
        answer, 1 a refusal, 2 usage, 3 nothing serving — so `succeed` is the
        assertion that the verb answered."""
        body = shlex.quote(json.dumps(dict(payload, rootToken=ROOT_TOKEN)))
        return machine.succeed(f"{env} {odu} surface {row} {verb} --input {body} --json")

    created = json.loads(
        surface(
            server,
            admin,
            "cache",
            "bucket_create",
            {"name": "main", "public": True, "retentionDays": 90},
        )
    )
    assert created["url"] == "http://cache.test/cache/main", created["url"]
    key = created["publicKey"]
    assert key.startswith("main-1:"), key

    token = json.loads(
        surface(server, admin, "cache", "token_mint", {"bucket": "main", "scope": "write"})
    )["token"]

    # ── a path BUILT on the server, pushed through the proxy ────────────────
    # A build output, not `nix store add-path`. A path named after its own
    # contents carries a `CA:` line, and Nix takes it from any cache it may ask,
    # signed or not; only a build output makes a fetch below depend on the
    # bucket's key. `/bin/sh` is in the build sandbox on NixOS, so the
    # derivation needs nothing from nixpkgs.
    def derivation(name, content):
        return (
            f'derivation {{ name = "{name}"; system = builtins.currentSystem;'
            f' builder = "/bin/sh"; args = [ "-c" "echo {content} > $out" ]; }}'
        )

    server.succeed(
        f"echo {shlex.quote(derivation('payload', 'odu-module-test'))} > /tmp/payload.nix"
    )
    path = server.succeed("nix-build --no-out-link /tmp/payload.nix").strip()
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
    surface(
        server,
        admin,
        "cache",
        "bucket_create",
        {"name": "secret", "public": False, "retentionDays": 90},
    )
    secret_token = json.loads(
        surface(server, admin, "cache", "token_mint", {"bucket": "secret", "scope": "write"})
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

    # ── THE SCRAPE, THROUGH NGINX ───────────────────────────────────────────
    # A HOST route on a cache-only deployment: the module has to proxy it, and
    # it has to carry a credential. Both halves are asserted, because a
    # location that was forgotten and a route that answered anonymously look
    # the same from a dashboard.
    metrics = client.succeed(
        f"curl -sS -H 'Authorization: Bearer {ROOT_TOKEN}' http://cache.test/metrics"
    )
    assert "odu_cache_paths{" in metrics, metrics[:300]
    scrape_anon = client.succeed(
        "curl -sS -o /dev/null -w '%{http_code}' http://cache.test/metrics"
    ).strip()
    assert scrape_anon == "401", f"an anonymous scrape answered {scrape_anon}"

    # ── A BUCKET'S OWN NAME ─────────────────────────────────────────────────
    # The name is a fact of the bucket; nginx needs a vhost for it (eval time),
    # and the daemon answers by `Host` — no rewrite, no bucket in the path.
    surface(server, admin, "cache", "bucket_domain", {"bucket": "main", "domain": "main.test"})
    info = client.succeed("curl -sS http://main.test/nix-cache-info")
    assert "WantMassQuery: 1" in info, info

    # THE NAME IS THE BUCKET'S ONLY. `/` is its page; the board, `/mcp` and
    # the door's own paths never answer there; another bucket's path is the
    # cache row's 404.
    public_page = client.succeed("curl -sS http://main.test/")
    assert "extra-substituters" in public_page, public_page[:300]
    assert 'aria-label="board rows"' not in public_page, "the board answered a bucket name"
    # `/metrics` included: a bucket's name forwards every path to this daemon,
    # and the host's numbers must not be readable at a substituter's address.
    for outside in ["/mcp", "/auth/github", "/rpc/ws", "/assets/app.js", "/cache/other", "/metrics"]:
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

    # ── A TEAM MEMBER'S MACHINE, through the Nix daemon ─────────────────────
    # Every fetch above is root copying into a side store with the key named on
    # the command line. A person's machine does neither: an ordinary user asks
    # the daemon, and the daemon decides which caches and keys count.
    def as_alice(command):
        return f"runuser -l alice -c {shlex.quote(command)}"

    zlaptop.wait_for_unit("multi-user.target")
    assert zlaptop.succeed("getent hosts main.test").split()[0] == server_ip
    # The daemon itself says alice is not trusted, so everything below is about
    # an ordinary user.
    alice_store = json.loads(zlaptop.succeed(as_alice("nix store info --json")))
    assert alice_store["trusted"] in (0, False), alice_store

    # THE LINES, as a team member gets them: `odu cache use`, from her own
    # account, with no token. The `nix.conf` block is the one whose lines are
    # the bare settings.
    use = zlaptop.succeed(as_alice("odu cache use main --origin http://cache.test"))
    nix_conf = next(
        block
        for block in use.split("\n\n")
        if any(line.startswith("extra-substituters = ") for line in block.splitlines())
    )
    settings = dict(
        line.split(" = ", 1) for line in nix_conf.splitlines() if not line.startswith("#")
    )
    bucket_url = settings["extra-substituters"]
    assert bucket_url == "http://main.test", use
    assert settings["extra-trusted-public-keys"] == key, use

    # The path exists only on the server and in the bucket. It was built there,
    # and this machine has no derivation for it, so nothing here can build it:
    # having it means it was fetched. And the bucket serves it with no `CA:`
    # line, so fetching it needs a signature this machine trusts.
    zlaptop.fail(f"nix-store --check-validity {path}")

    def narinfo(machine, url, store_path):
        """What the bucket serves for a path, which must be there."""
        return machine.succeed(f"curl -sSf {url}/{store_path.split('/')[-1][:32]}.narinfo")

    served = narinfo(zlaptop, bucket_url, path)
    assert f"StorePath: {path}" in served, served
    assert not any(line.startswith("CA:") for line in served.splitlines()), served

    # ── 1. HER OWN SETTINGS DO NOTHING ──────────────────────────────────────
    # The same address and key, on her command line and then in her own
    # `nix.conf`. The daemon ignores both, says so, and Nix has no way to get
    # the path.
    flags = zlaptop.execute(
        as_alice(
            f"nix build --no-link --option substituters {bucket_url}"
            f" --option trusted-public-keys {key} {path} 2>&1"
        )
    )
    print(flags)
    assert flags[0] != 0, flags
    assert "ignoring untrusted substituter" in flags[1], flags[1]
    zlaptop.fail(f"nix-store --check-validity {path}")

    zlaptop.succeed(
        "install -d -o alice /home/alice/.config /home/alice/.config/nix"
        f" && echo {shlex.quote(nix_conf)} > /home/alice/.config/nix/nix.conf"
    )
    own = zlaptop.execute(as_alice(f"nix build --no-link {path} 2>&1"))
    print(own)
    assert own[0] != 0, own
    assert "ignoring untrusted substituter" in own[1], own[1]
    zlaptop.succeed("rm -r /home/alice/.config/nix")
    zlaptop.fail(f"nix-store --check-validity {path}")

    # ── 2. THE ADDRESS ALONE IN THE MACHINE'S CONFIGURATION DOES NOTHING ────
    # The block followed halfway: the address in the file the machine's
    # `nix.conf` includes, the key left out, and the daemon restarted to read
    # it. The daemon asks the bucket now, and refuses what it answers, because
    # no key it trusts signed it.
    address_only = "\n".join(
        line
        for line in nix_conf.splitlines()
        if not line.startswith("extra-trusted-public-keys")
    )
    zlaptop.succeed(f"echo {shlex.quote(address_only)} > /etc/nix/odu-bucket.conf")
    zlaptop.succeed("systemctl restart nix-daemon.service")
    unsigned = zlaptop.execute(as_alice(f"nix build --no-link {path} 2>&1"))
    print(unsigned)
    assert unsigned[0] != 0, unsigned
    assert "not signed by any of the keys" in unsigned[1], unsigned[1]
    zlaptop.fail(f"nix-store --check-validity {path}")

    # ── 3. THE WHOLE BLOCK IN THE MACHINE'S CONFIGURATION DOES ──────────────
    # The same file with the key in it too. Now an ordinary `nix build` fetches
    # the path, signed with the bucket's key.
    zlaptop.succeed(f"echo {shlex.quote(nix_conf)} > /etc/nix/odu-bucket.conf")
    zlaptop.succeed("systemctl restart nix-daemon.service")
    fetched = zlaptop.execute(as_alice(f"nix build --no-link {path} 2>&1"))
    print(fetched)
    assert fetched[0] == 0, fetched
    zlaptop.succeed(f"nix-store --check-validity {path}")
    key_name = key.split(":")[0]
    zlaptop.succeed(f"nix path-info --sigs {path} | grep -F '{key_name}:'")

    # ── 4. SHE PUSHES A PATH OF HER OWN ─────────────────────────────────────
    # One she builds, so it has no `CA:` line either: another machine can only
    # take it from the bucket with the signature odu adds on the push. A write
    # token saved with `odu cache login`, then `odu cache push` to the address
    # from her `nix.conf`. The push talks to the cache itself, as her, so the
    # daemon's rules are not in the way.
    mine_nix = shlex.quote(derivation("mine", "made-on-the-laptop"))
    zlaptop.succeed(as_alice(f"echo {mine_nix} > ~/mine.nix"))
    mine = zlaptop.succeed(as_alice("nix-build --no-out-link ~/mine.nix")).strip()
    zlaptop.succeed(as_alice(f"odu cache login http://cache.test --token {token}"))
    mine_pushed = json.loads(
        zlaptop.succeed(as_alice(f"odu cache push --cache {bucket_url} {mine} -o json"))
    )
    assert mine_pushed["pushed"] == 1 and mine_pushed["failed"] == 0, mine_pushed
    # AND THE BUCKET SERVES IT, with no `CA:` line: another machine fetches it,
    # trusting only the bucket's key.
    served_mine = narinfo(client, bucket_url, mine)
    assert not any(line.startswith("CA:") for line in served_mine.splitlines()), served_mine
    from_laptop = client.execute(
        f"nix copy --from {bucket_url} --to local?root=/tmp/sub-laptop"
        f" --option trusted-public-keys '{key}' {mine}"
    )
    print(from_laptop)
    assert from_laptop[0] == 0, from_laptop
    client.succeed(
        f"NIX_REMOTE=local?root=/tmp/sub-laptop nix store verify {mine}"
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
    # ANONYMOUS READS ARE THE S3 BUCKET'S OWN DOING. versitygw refuses an
    # unsigned GET until a policy says otherwise, and that policy is the
    # gateway's spelling of what binding an R2 custom domain does: every
    # object under this ONE S3 bucket becomes world-readable. Which is why
    # odu advertises the store's name for PUBLIC odu buckets only.
    public_read = json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": "*",
            "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::odu-objects/*",
        }],
    })
    server.succeed(
        f"curl -sSf {s3} -X PUT --data-binary {shlex.quote(public_read)}"
        f" 'http://127.0.0.1:7070/odu-objects?policy'"
    )
    far = json.loads(
        surface(
            server,
            admin,
            "cache",
            "bucket_create",
            {"name": "far", "public": True, "retentionDays": 90, "store": "s3"},
        )
    )
    assert far["store"] == "s3", far
    far_key = far["publicKey"]
    far_token = json.loads(
        surface(server, admin, "cache", "token_mint", {"bucket": "far", "scope": "write"})
    )["token"]
    pushed = server.succeed(
        f"runuser -u odu -- env ODU_WEB_ORIGIN=http://127.0.0.1:18440"
        f" ODU_CACHE_TOKEN={far_token} {odu} cache push far {path} -o json"
    )
    # ── THE BYTES NEVER CROSSED THE DAEMON (PLAN 2.9) ──────────────────────
    # A bucket on an S3 store negotiates `direct`: the client is handed
    # presigned URLs, PUTs the NAR to the gateway itself, and odu reads the
    # object back to prove it before recording the path. The client's own
    # summary says which mode it used, and the daemon's log says what it saw.
    assert json.loads(pushed)["mode"] == "direct", pushed
    server.succeed(
        "journalctl -u odu-web --no-pager | grep -F 'cache.nar.uploaded'"
        " | grep -E '\"mode\": ?\"direct\"' | grep -E '\"bucket\": ?\"far\"'"
    )
    # THE BYTES ARE IN THE S3 BUCKET, under the odu bucket's prefix — and not
    # on the daemon's disk.
    listed = server.succeed(f"curl -sSf {s3} 'http://127.0.0.1:7070/odu-objects?list-type=2&prefix=far/'")
    assert "<Key>far/nar/" in listed, listed
    server.fail("ls /var/lib/odu/cache/objects/far")
    # ── THE NAR IS NOT ODU'S TO SERVE when the bucket is on an S3 store ────
    # PLAN 2.8: odu answers a NAR on an S3 store with a 307 to a PRESIGNED
    # GET on the gateway and no body at all. The redirect is asserted as
    # ITSELF — the code, and a `location` on the gateway's own host — because
    # a test that only followed it could not tell a redirect from a proxy.
    far_file = client.succeed(
        "curl -sS http://cache.test/cache/far/%s.narinfo | sed -n 's|^URL: nar/||p'"
        % path.split("/")[-1][:32]
    ).strip()
    nar_code = client.succeed(
        f"curl -sS -o /dev/null -w '%{{http_code}}'"
        f" http://cache.test/cache/far/nar/{far_file}"
    ).strip()
    assert nar_code == "307", f"a NAR on an S3 store answered {nar_code}, not a redirect"
    location = client.succeed(
        f"curl -sS -D - -o /dev/null http://cache.test/cache/far/nar/{far_file}"
        " | sed -n 's|^[Ll]ocation: ||p'"
    ).strip()
    assert location.startswith("http://gateway.test:7070/odu-objects/far/nar/"), location
    assert "X-Amz-Signature=" in location, location
    # AND THE RANGE IS THE STORE'S TOO: odu does not proxy one, so the client
    # re-sends the header to the address the redirect named.
    ranged = client.succeed(
        f"curl -sSL -D - -o /dev/null -H 'Range: bytes=0-3'"
        f" http://cache.test/cache/far/nar/{far_file}"
    )
    assert "206 partial content" in ranged.lower(), ranged
    assert "content-length: 4" in ranged.lower(), ranged
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

    # ── READS WITH ODU STOPPED — what PLAN 2.8 is for ──────────────────────
    # The store declares a `publicUrl`, so a PUBLIC bucket on it advertises
    # the store's own name instead of odu's, and everything the Nix protocol
    # asks for is an object the push wrote: `nix-cache-info`, the narinfo,
    # the NAR. Stop the daemon and the cache still serves.
    assert far["url"] == "http://public.test/far", far["url"]
    for probe in ["nix-cache-info", "%s.narinfo" % path.split("/")[-1][:32], f"nar/{far_file}"]:
        code = client.succeed(
            f"curl -sS -o /dev/null -w '%{{http_code}}' http://public.test/far/{probe}"
        ).strip()
        assert code == "200", f"http://public.test/far/{probe} answered {code} with odu up"

    server.succeed("systemctl stop odu-web.service")
    server.fail("curl -sS --max-time 5 -o /dev/null http://127.0.0.1:18440/")
    without_odu = client.execute(
        f"nix copy --from http://public.test/far --to local?root=/tmp/sub-down"
        f" --option trusted-public-keys '{far_key}' {path}"
    )
    print(without_odu)
    assert without_odu[0] == 0, without_odu
    client.succeed(
        f"NIX_REMOTE=local?root=/tmp/sub-down nix store verify {path}"
        f" --option trusted-public-keys '{far_key}'"
    )
    # The steps after this one are the daemon's again.
    server.succeed("systemctl start odu-web.service")
    server.wait_for_unit("odu-web.service")
    server.wait_until_succeeds("curl -sS -o /dev/null http://127.0.0.1:18440/")

    # ── administration works, and collection does not eat the bucket ────────
    surface(server, admin, "cache", "stats_read", {})
    surface(server, admin, "cache", "gc_run", {"bucket": "main"})

    # ── the OTHER shape: a daemon with a door ───────────────────────────────
    zdoor.wait_for_unit("odu-web.service")
    zdoor.wait_for_unit("nginx.service")
    surface(
        zdoor,
        "runuser -u odu -- env ODU_WEB_ORIGIN=http://127.0.0.1:18440 HOME=/var/lib/odu",
        "auth",
        "user_grant",
        {"login": "srid", "role": "owner"},
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

