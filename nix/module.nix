# THE NIXOS MODULE FOR THE SERVICE, which is one process: the board, the CI it
# runs, and the binary cache it serves.
#
# TWO SHAPES, and `github` is the switch between them.
#
#   - WITHOUT `services.odu.github`, there is no public board. The daemon binds
#     a loopback address and nginx proxies exactly the cache's two route
#     families, because the board and `/mcp` have no authentication of their own
#     — a module that put them on the internet would open a CI server to the
#     world.
#   - WITH it, the daemon has a DOOR: sign-in through a GitHub App, sessions,
#     personal tokens, roles. nginx then proxies the board, the websocket and
#     `/mcp` as well, and every caller meets the sign-in page before anything
#     else. That is server mode, and it is what makes the public board safe.
#
# Nor is there object storage, a second store, or a signing service: a bucket is
# metadata over the host's own `/nix/store`, the server signs at read, and the
# state lives in one SQLite file under `stateDir`.
{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.odu;
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    optionals
    optionalString
    optionalAttrs
    types
    ;

  # `StateDirectory` takes a NAME under /var/lib, not a path. Deriving it keeps
  # one authority: whatever `stateDir` says is where the database, the gcroots
  # and the staging directory go, and systemd is told the same name.
  stateDirName = baseNameOf (toString cfg.stateDir);

  # `http://127.0.0.1:18440`, `http://[::1]:18440`, `http://localhost:18440`.
  # A loopback literal rather than a resolver call, because this is an assertion
  # about where the daemon may bind, and a hostname that resolves to something
  # else today is exactly what it is here to refuse.
  # The IPv6 literal is spelled `.::1.` rather than `\[::1\]`: Nix runs POSIX
  # ERE, where a backslash-escaped bracket is an invalid expression, and the two
  # dots match the brackets a URL puts around an address.
  isLoopback = builtins.match
    "https?://(127[.]0[.]0[.]1|localhost|.::1.)(:[0-9]+)?/?"
    cfg.listen != null;

  # Both route families get the same treatment, and the same `extraConfig`
  # the docs have had since the cache shipped. `client_max_body_size 0` and the
  # two buffering switches are not tuning: a NAR is gigabytes, and a proxy that
  # buffers one holds it in memory or in a temp file before odu sees a byte.
  proxyRules = ''
    proxy_pass_request_headers on;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  '';

  # NO trailing slash. `proxy_pass http://host:port/` carries a URI part, and
  # nginx then REPLACES the matched location prefix with it — `/cache/main/…`
  # would reach the daemon as `/main/…`. odu strips a trailing slash for itself
  # when it parses an origin; nginx does not, so the module does it here.
  daemonUrl = lib.removeSuffix "/" cfg.listen;

  proxyLocation = {
    proxyPass = daemonUrl;
    extraConfig = proxyRules;
  };

  # THE READ CACHE IS FOR NARS, and only for NARs. A narinfo is a few hundred
  # bytes and its hit count is a fact the bucket publishes, so it must reach
  # odu; a NAR is the gigabytes, and a second fetch of the same one is the
  # commonest thing a build farm does. `$host$request_uri` keys the two forms
  # of the same object apart: a bucket domain and the path form are different
  # names for the same bytes, and a cache that merged them would answer one
  # name with the other's header.
  narLocation = {
    proxyPass = daemonUrl;
    # THE SAME STREAMING RULES, EXCEPT BUFFERING: `proxyRules` turns response
    # buffering off so odu streams a NAR straight to the socket, and a cached
    # NAR is the opposite trade — one copy on disk that every later reader
    # shares. `proxy_buffering on` is therefore stated here instead, not added
    # to a rules string that already says off (nginx refuses the duplicate).
    extraConfig = ''
      proxy_pass_request_headers on;
      client_max_body_size 0;
      proxy_request_buffering off;
      proxy_read_timeout 3600s;
      proxy_buffering on;
      proxy_cache odu_nar;
      proxy_cache_lock on;
      # A REQUEST THAT CARRIES A CREDENTIAL IS NEVER SERVED FROM, OR STORED IN,
      # THE SHARED CACHE. It is how a private bucket's authorised read would
      # otherwise become the next anonymous reader's HIT; the daemon's
      # `Cache-Control: private, no-store` is the other half.
      proxy_no_cache $http_authorization;
      proxy_cache_bypass $http_authorization;
      proxy_cache_valid 200 1h;
      proxy_cache_key "$host$request_uri";
      add_header X-Cache-Status $upstream_cache_status always;
    '';
  };

  # THE NIX PROTOCOL'S WHOLE FOOTPRINT AT A BUCKET'S OWN NAME. A bucket domain
  # answers at `/`, so the vhost proxies exactly the paths the cache claims —
  # and NOT `/`, which is the board's and stays on `cache.domain`.
  cacheLocations = {
    "/nix-cache-info" = proxyLocation;
    "/nar/" = proxyLocation;
    "/cache/" = proxyLocation;
    "/_odu/v1/" = proxyLocation;
    # nginx parses an unquoted `{32}` in a location regex as a block opener, so
    # the expression is quoted — and `[.]` avoids a backslash in the spelling.
    "~ \"^/[0-9abcdfghijklmnpqrsvwxyz]{32}[.]narinfo$\"" = proxyLocation;
    # EVERYTHING ELSE GOES TO THE DAEMON, which answers for the bucket only: `/`
    # is its public page, the paths above are the protocol, and the board,
    # `/mcp`, `/auth` and `/rpc/ws` are the cache row's 404. nginx cannot decide
    # that — the bucket a name belongs to is the daemon's fact.
    "/" = proxyLocation;
  };

  # IS THIS A SERVER MODE DEPLOYMENT? All three `github` options set; the
  # assertion above refuses a partial one.
  serverMode = cfg.github.clientId != null;

  # A WEBSOCKET IS NOT A REQUEST. nginx needs the upgrade pair on the location
  # that carries `/rpc/ws`, and `recommendedProxySettings` is what defines
  # `$connection_upgrade` — so this only works with it on, which the vhost sets.
  websocketRules = proxyRules + ''
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  '';
in
{
  options.services.odu = {
    enable = mkEnableOption "the odu service: the board, its CI runs, and its binary cache";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.odu;
      defaultText = lib.literalExpression "inputs.odu.packages.\${pkgs.stdenv.hostPlatform.system}.odu";
      description = ''
        The odu package to run. The default is this flake's own build for the
        host's platform, which is what a flake input gives you; override it only
        to pin a different revision of the same flake.
      '';
    };

    user = mkOption {
      type = types.str;
      default = "odu";
      description = ''
        The system user the service runs as. It is created if it does not
        exist, with `stateDir` as its home and no login shell: the daemon is a
        per-user process, and a per-user process on a server is a system user
        nobody logs in as.
      '';
    };

    group = mkOption {
      type = types.str;
      default = "odu";
      description = ''
        The system group the service runs as, created if it does not exist.
      '';
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/odu";
      description = ''
        Where the service keeps everything it owns: the run catalog, the
        request receipts, and the cache's SQLite database, signing keys, gcroots
        and staging directory. It is a systemd `StateDirectory` with mode 0700,
        and it is the service user's home, because the cache's keys are in it
        and nobody else has business reading them.
      '';
    };

    listen = mkOption {
      type = types.str;
      default = "http://127.0.0.1:18440";
      description = ''
        The address the daemon binds, as an origin. It must be a loopback
        address: the board and `/mcp` have no authentication in this release, so
        a directly-reachable service is a directly-administerable CI server. A
        public board is PR 3's (server mode) answer; until then a tailnet or an
        SSH forward is how you reach it.
      '';
    };

    rootTokenFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        A file holding the cache's root token, loaded as a systemd credential
        and exported to the daemon as `$ODU_ROOT_TOKEN`. This is the token that
        may create buckets, mint and revoke tokens, pin and collect, so it is a
        secret: it stays out of the Nix store and out of the unit's command
        line. With `null` the cache still serves and substitutes, but nothing
        can administer it — which is a working cache you cannot add a bucket to.
      '';
    };

    trustedUser = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Add `user` to `nix.settings.trusted-users`. A cache server has to be
        allowed to import paths built on other machines, and those paths carry
        no signature the daemon trusts; without this, a push from a lane other
        than this host is refused by Nix, not by odu.
      '';
    };

    allowedOrigins = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "https://box.tailnet.ts.net" ];
      description = ''
        Extra browser origins the websocket and `/mcp` admit, beyond
        same-origin. It is `$ODU_WEB_ALLOWED_ORIGINS` with commas: needed only
        when a proxy REWRITES the Host header, which makes the browser's Origin
        disagree with it — a tailnet name or a proxy that passes Host through
        needs nothing here. See "Access through Tailscale or a proxy" in the
        docs.

        `cache.domain` is deliberately not added: the virtual host answers 404
        at `/`, so no browser ever loads the board from that name.
      '';
    };

    publicOrigin = mkOption {
      type = types.nullOr types.str;
      # The scheme follows `cache.enableACME`, because that is the scheme the
      # virtual host actually serves: with ACME off the module forces a plain
      # HTTP vhost, and publishing `https://<domain>` for it would be a URL the
      # module itself does not answer on. A host that terminates TLS in front of
      # this machine sets this by hand.
      default =
        if cfg.cache.domain == null then null
        else "${if cfg.cache.enableACME then "https" else "http"}://${cfg.cache.domain}";
      defaultText = lib.literalExpression
        ''"${if cfg.cache.enableACME then "https" else "http"}://${cfg.cache.domain}"'';
      description = ''
        The origin a bucket's substituter URL is published under, when a proxy
        stands in front. `odu cache use` prints this, so it has to be the
        address a client can actually reach — behind nginx the bound address is
        loopback and a URL no client can reach is worse than none. The board's
        own identity stays on `listen`, and nothing about the board's origins
        follows from this: see `allowedOrigins`.

        The default follows `cache.domain` and `cache.enableACME`, so it names
        the scheme the module's own virtual host serves. A host that terminates
        TLS elsewhere — a load balancer, a tunnel — sets it by hand.
      '';
    };

    cache.domain = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        The public hostname this SERVICE is served at — and, with `github` set,
        the board's as well. Setting it turns on nginx with one virtual host that
        proxies the cache's route families (and, in server mode, the board, the
        websocket and `/mcp`) and makes `publicOrigin` `https://<domain>`.

        A bucket's OWN name is `cache.bucketDomains`, not this: this one carries
        the board, and a bucket domain answers only the Nix protocol.
      '';
    };

    cache.bucketDomains = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "cache.example.org" ];
      description = ''
        DNS names that belong to BUCKETS, each getting its own virtual host with
        its certificate and exactly the Nix protocol's paths at `/`. The daemon
        answers a name by its `Host`, so the same name must also be set on the
        bucket itself (`odu cache domain <bucket> <name>`, or the bucket page's
        Domain field); this option is what puts nginx and a certificate in
        front of it.

        A bucket domain is a NAME, not read access control: a public bucket
        stays readable without a token, and the board is not served on these
        names.
      '';
    };

    github = {
      clientId = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "Iv1.0123456789abcdef";
        description = ''
          The GitHub App's **Client ID**. Setting this, `clientSecretFile` and
          `allow` turns this daemon into a server with a door: anonymous
          browsers meet a sign-in page, `/mcp` answers 401 without a token, and
          every verb runs as a signed-in person with a role.

          One App per instance: the App's callback URL is this deployment's
          alone, so two odu servers need two Apps. See "Server mode" in the
          docs for creating one, field by field.
        '';
      };

      clientSecretFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = ''
          A file holding the App's **client secret**, loaded as a systemd
          credential and handed to the daemon as
          `$ODU_GITHUB_CLIENT_SECRET_FILE`. A secret: keep it out of the Nix
          store — a runtime path (`/run/secrets/…`, or whatever syncs it) is
          what this option is for.
        '';
      };

      allow = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "org:juspay" "team:juspay/platform" "srid" ];
        description = ''
          Who may sign in: `org:<name>`, `team:<org>/<slug>`, or a GitHub login.
          Any of them lets the person in, as a `member`; roles are granted
          afterwards (`odu auth grant <login> owner` with the root token is the
          bootstrap).

          Membership is read with the person's own token in this release, which
          works because the App is installed on the organisation — a `team:` or
          `org:` rule needs an org owner to install it.
        '';
      };
    };

    cloudflare = {
      apiTokenFile = mkOption {
        type = types.nullOr types.path;
        default = null;
        example = "/run/secrets/cloudflare-api-token";
        description = ''
          A file holding a Cloudflare API token. Setting it mounts the
          `cloudflare` row: it makes ONE tunnel for this server, routes each
          bucket that has a domain, keeps the proxied DNS record, and runs
          `cloudflared` as a child of the daemon. The token needs
          **Zone:DNS:Edit** and **Account:Cloudflare Tunnel:Edit**; a missing or
          inactive token refuses the row at boot, naming what Cloudflare said.

          This is how `cache.kolu.dev` exists on a host with no public port:
          the tunnel is outbound, so neither nginx nor the firewall has to
          expose anything. The same tunnel carries \`publicOrigin\`'s host when
          the token can edit its zone, which is what lets a Tailscale Funnel
          retire — and moves the GitHub App's callback URL to that name.

          The token is loaded as a systemd credential, not put in the Nix store.
        '';
      };
    };

    cache.enableACME = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Ask Let's Encrypt for the virtual host's certificate and redirect HTTP
        to HTTPS. Set it to `false` for a hostname that terminates TLS in front
        of this machine, or in a test that speaks plain HTTP; the virtual host
        is then plain HTTP.
      '';
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Open ports 80 and 443. Only meaningful with `cache.domain` set — there
        is nothing else this module exposes — and off by default, because a
        firewall rule is the operator's decision and not a package's.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = isLoopback;
        message = ''
          services.odu.listen is ${cfg.listen}, which is not a loopback address.
          The daemon binds loopback and a proxy stands in front, in BOTH shapes:
          without services.odu.github nothing authenticates a request at all, and
          with it the session cookie is only Secure behind TLS.
        '';
      }
      {
        # HALF A DOOR IS A REFUSAL AT BOOT, so it is a refusal here too: a
        # daemon that silently stopped asking for sign-in because one option was
        # misspelled would be a door that looks shut and is not.
        assertion =
          (cfg.github.clientId != null) == (cfg.github.clientSecretFile != null)
          && (cfg.github.clientId != null) == (cfg.github.allow != [ ]);
        message = ''
          services.odu.github needs clientId, clientSecretFile and allow TOGETHER,
          or none of them. With none, this daemon has no door and every caller is
          its owner; with all three it is a server that asks who you are.
        '';
      }
      {
        # ONE NAME, ONE VHOST. A duplicate in the list would silently pick one
        # entry, and `cache.domain` already owns the board's vhost — a bucket
        # domain there would replace it rather than add to it.
        assertion =
          builtins.length (lib.unique cfg.cache.bucketDomains) == builtins.length cfg.cache.bucketDomains
          && !(builtins.elem cfg.cache.domain cfg.cache.bucketDomains);
        message = ''
          services.odu.cache.bucketDomains must be distinct, and must not
          repeat services.odu.cache.domain: the board's vhost and a bucket's
          would collide, and one of them would answer for the other.
        '';
      }
    ];

    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = toString cfg.stateDir;
      homeMode = "0700";
    };

    # A cache server imports what other machines built, and an unsigned path
    # from a trusted user is the only way that works.
    nix.settings.trusted-users = optionals cfg.trustedUser [ cfg.user ];

    systemd.services.odu-web = {
      description = "odu — the board, its CI runs, and its binary cache";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "nix-daemon.service" ];
      # `nix` is the host's, deliberately unpinned: the cache serves THIS
      # machine's store, and a pinned nix would be a second idea about what the
      # store is. `git` is for the CI half — a host that only caches needs nothing
      # from it, and having it on PATH costs a resolution.
      path = [ config.nix.package pkgs.git ];
      script = ''
        ${optionalString (cfg.rootTokenFile != null) ''
          # A credential, not a `--setenv`: systemd copies the file into a
          # private directory the unit can read and nothing else can.
          export ODU_ROOT_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/root-token")"
        ''}
        # FOREGROUND. `--background` is how a person leaves a daemon behind a
        # shell; under systemd the unit IS the daemon, and a service that forks
        # is a service whose exit status systemd cannot see.
        exec ${cfg.package}/bin/odu web
      '';
      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        StateDirectory = stateDirName;
        StateDirectoryMode = "0700";
        Environment = [
          "ODU_STATE_DIR=${cfg.stateDir}"
          "HOME=${cfg.stateDir}"
          "ODU_WEB_ORIGIN=${cfg.listen}"
        ]
        ++ optionals (cfg.publicOrigin != null) [
          "ODU_PUBLIC_ORIGIN=${cfg.publicOrigin}"
        ]
        ++ optionals serverMode [
          "ODU_GITHUB_CLIENT_ID=${cfg.github.clientId}"
          # The credential's own runtime path: systemd copies the file into a
          # private directory, and this is the file the daemon reads.
          "ODU_GITHUB_CLIENT_SECRET_FILE=%d/client-secret"
          "ODU_GITHUB_ALLOW=${builtins.concatStringsSep "," cfg.github.allow}"
        ]
        ++ optionals (cfg.allowedOrigins != [ ]) [
          "ODU_WEB_ALLOWED_ORIGINS=${builtins.concatStringsSep "," cfg.allowedOrigins}"
        ]
        ++ optionals (cfg.cloudflare.apiTokenFile != null) [
          # The credential's runtime path: systemd copies the file into a
          # private directory, and this is the file the daemon reads.
          "ODU_CLOUDFLARE_API_TOKEN_FILE=%d/cloudflare-api-token"
        ];
        Restart = "on-failure";
      } // lib.optionalAttrs
        (
          cfg.rootTokenFile != null || serverMode || cfg.cloudflare.apiTokenFile != null
        )
        {
          # ONE list: two `//` updates would replace each other, and a missing
          # credential is a daemon that cannot read its own secret.
          LoadCredential = optionals (cfg.rootTokenFile != null) [
            "root-token:${cfg.rootTokenFile}"
          ] ++ optionals serverMode [
            "client-secret:${toString cfg.github.clientSecretFile}"
          ] ++ optionals (cfg.cloudflare.apiTokenFile != null) [
            "cloudflare-api-token:${toString cfg.cloudflare.apiTokenFile}"
          ];
        };
    };

    services.nginx = mkIf (cfg.cache.domain != null || cfg.cache.bucketDomains != [ ]) {
      enable = true;
      recommendedProxySettings = true;
      # The zone lives here rather than in a vhost: both vhost shapes read from
      # it, and one declaration is one place for its size to be argued about.
      appendHttpConfig = ''
        proxy_cache_path /var/cache/nginx/odu-nar levels=1:2 keys_zone=odu_nar:10m
          max_size=10g inactive=7d use_temp_path=off;
      '';
      virtualHosts =
        lib.optionalAttrs (cfg.cache.domain != null)
          {
            ${cfg.cache.domain} = {
              enableACME = cfg.cache.enableACME;
              forceSSL = cfg.cache.enableACME;
              # TWO SETS OF LOCATIONS, one per shape.
              #
              # WITHOUT a door: the cache's protocol and its admin API, and
              # NOTHING else. `/` is an explicit 404 rather than an absent
              # location: with no `location /` and no `root`, nginx falls back to
              # its own `html/index.html` and answers "Welcome to nginx" with a
              # 200 — which is not the board, but is not the 404 this module
              # promised either.
              #
              # WITH one: everything the daemon serves, because the door is what
              # makes it safe to. `/rpc/ws` carries the websocket upgrade; `/`
              # carries the board and every static asset; `/mcp` an agent's
              # endpoint. `/auth/…` rides `/` — the OAuth redirect and the
              # callback are ordinary requests.
              locations =
                if serverMode then {
                  "/rpc/ws" = {
                    proxyPass = daemonUrl;
                    extraConfig = websocketRules;
                  };
                  "/" = proxyLocation;
                } else {
                  # The NAR paths are regexes so they win over the `/cache/`
                  # prefix beside them; everything else under `/cache/` is a
                  # narinfo or the push API, which must not be cached.
                  "~ ^/cache/[a-z0-9-]+/nar/" = narLocation;
                  "/cache/" = proxyLocation;
                  "/_odu/v1/" = proxyLocation;
                  "/" = { return = "404"; };
                };
            };
          }
        # ONE VHOST PER BUCKET NAME, each with its own certificate and exactly
        # the Nix protocol's paths. The daemon decides WHICH bucket a `Host`
        # names; nginx only has to let the request through.
        // lib.listToAttrs (
          map
            (domain: lib.nameValuePair domain {
              enableACME = cfg.cache.enableACME;
              forceSSL = cfg.cache.enableACME;
              locations = cacheLocations // {
                "~ ^/nar/" = narLocation;
              };
            })
            cfg.cache.bucketDomains
        );
    };

    networking.firewall.allowedTCPPorts =
      optionals ((cfg.cache.domain != null || cfg.cache.bucketDomains != [ ]) && cfg.openFirewall) [
        80
        443
      ];
  };
}
