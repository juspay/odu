# THE NIXOS MODULE FOR THE SERVICE, which is one process: the board, the CI it
# runs, and the binary cache it serves.
#
# What it deliberately is NOT: there is no public board. The daemon binds a
# loopback address and the module's nginx proxies exactly the cache's two route
# families, because the board and `/mcp` have no authentication in this release
# — a module that put them on the internet would be a module that opened a CI
# server to the world. A public board is PR 3's (server mode) answer, and the
# `listen` assertion says so in as many words.
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

  proxyLocation = {
    proxyPass = cfg.listen;
    extraConfig = proxyRules;
  };
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
        loopback and a URL no client can reach is worse than none. It is also
        admitted as a browser origin, since that is the address the board is
        reached by. The board's own identity stays on `listen`.

        The default follows `cache.domain` and `cache.enableACME`, so it names
        the scheme the module's own virtual host serves. A host that terminates
        TLS elsewhere — a load balancer, a tunnel — sets it by hand.
      '';
    };

    cache.domain = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        The public hostname a bucket is served at. Setting it turns on nginx
        with one virtual host that proxies `/cache/` and `/_odu/v1/` to the
        daemon and **nothing else** — no `location /`, so the board answers 404
        from outside — and makes `publicOrigin` `https://<domain>`.
      '';
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
          The board and /mcp have no authentication in this release, so the
          daemon has to bind loopback and a proxy has to stand in front. A
          public board is PR 3's (server mode) answer; until then reach it over
          a tailnet or an SSH forward.
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
          # The board is reached at the public name, so a browser there sends an
          # Origin the listener has to admit.
          "ODU_WEB_ALLOWED_ORIGINS=${cfg.publicOrigin}"
        ];
        Restart = "on-failure";
      } // optionalAttrs (cfg.rootTokenFile != null) {
        LoadCredential = "root-token:${cfg.rootTokenFile}";
      };
    };

    services.nginx = mkIf (cfg.cache.domain != null) {
      enable = true;
      recommendedProxySettings = true;
      virtualHosts.${cfg.cache.domain} = {
        enableACME = cfg.cache.enableACME;
        forceSSL = cfg.cache.enableACME;
        # The cache's protocol and its admin API, and NOTHING else. `/` is an
        # explicit 404 rather than an absent location: with no `location /` and
        # no `root`, nginx falls back to its own `html/index.html` and answers
        # "Welcome to nginx" with a 200 — which is not the board, but is not the
        # 404 this module promised either, and a security claim that is merely
        # "probably not the board" is not one worth making.
        locations = {
          "/cache/" = proxyLocation;
          "/_odu/v1/" = proxyLocation;
          "/" = { return = "404"; };
        };
      };
    };

    networking.firewall.allowedTCPPorts =
      optionals (cfg.cache.domain != null && cfg.openFirewall) [ 80 443 ];
  };
}
