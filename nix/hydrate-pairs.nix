{ lib }:

pairs: lib.concatMapStringsSep " " (pair: "${pair.src} ${pair.dest}") pairs
