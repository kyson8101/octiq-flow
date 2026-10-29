#!/usr/bin/env bash
# Keep dependencies and installed/top-level binaries; prune only stale own-crate caches.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
days=2
dry_run=0
worktrees=0
targets=()
while (($#)); do
  case "$1" in
    --days) [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo 'Expected --days N' >&2; exit 2; }; days="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --worktrees) worktrees=1; shift ;;
    --help) echo "Usage: $0 [--days N] [--dry-run] [--worktrees] [target ...]"; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) targets+=("$1"); shift ;;
  esac
done
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
if pgrep -x cargo >/dev/null || pgrep -x rustc >/dev/null; then
  log 'Skipped whole run: cargo or rustc is running.'
  exit 0
fi
if ((worktrees)); then
  # Enumerate at execution time: newly created worktrees need no reinstall.
  # Also include leftover target folders under each discovered worktree base.
  listing="$(git -c core.quotePath=false -C "$REPO" worktree list --porcelain)"
  while IFS= read -r line; do
    [[ "$line" == 'worktree '* ]] || continue
    root="${line#worktree }"
    targets+=("$root/src-tauri/target")
    if [[ "$root" == */.worktrees/*/*/* ]]; then
      base="${root%/*/*}"
      for target in "$base"/*/*/src-tauri/target; do
        [[ -d "$target" ]] && targets+=("$target")
      done
    fi
  done <<< "$listing"
fi
((${#targets[@]})) || targets+=("$REPO/src-tauri/target")
# Perl is shipped by macOS. One metadata pass avoids spawning stat/find once
# per CGU object (there can be tens of thousands). No symlinks are followed.
/usr/bin/perl - "$days" "$dry_run" "${targets[@]}" <<'PERL'
use strict;
use warnings;
use File::Find ();
use File::Path qw(remove_tree);
use POSIX qw(strftime);
my ($days, $dry, @targets) = @ARGV;
my $cutoff = time - $days * 86400;
my $own = qr/(?:octiq_flow_lib|octiq_server|octiq_notify|octiq_job|octiq)/;
my %seen;
sub allocated {
    my ($path) = @_;
    open my $du, '-|', '/usr/bin/du', '-sk', $path or die "du: $!";
    my $line = <$du>;
    close $du or die "du failed for $path\n";
    $line =~ /^(\d+)/ or die "Invalid du output\n";
    return $1 * 1024;
}
sub walk {
    my ($path, $visit) = @_;
    File::Find::find({ no_chdir => 1, wanted => sub {
        my @st = lstat($File::Find::name);
        die "lstat $File::Find::name: $!" unless @st;
        $visit->($File::Find::name, \@st);
    }}, $path);
}
for my $target (@targets) {
    unless (-d $target && !-l $target) {
        print strftime("%Y-%m-%d %H:%M:%S", localtime), " SKIPPED target=$target (missing or symlink)\n";
        next;
    }
    # Canonicalize only the supplied root, not any descendant cache path.
    require Cwd;
    $target = Cwd::abs_path($target);
    next if $seen{$target}++;
    opendir my $td, $target or die "$target: $!";
    my @profiles = sort grep { $_ ne '.' && $_ ne '..' } readdir $td;
    closedir $td;
    for my $name (@profiles) {
        my $profile = "$target/$name";
        next unless -d "$profile/deps" && !-l $profile && !-l "$profile/deps";
        my $before = allocated($profile);
        my (%groups, @remove);
        opendir my $deps, "$profile/deps" or die "$profile/deps: $!";
        while (my $file = readdir $deps) {
            # Exact crate and hash boundaries: never match third-party prefixes.
            next unless $file =~ /^(?:lib)?($own)-([0-9a-f]+)(?:[.\-].*)?$/;
            push @{$groups{$2}}, "$profile/deps/$file";
        }
        closedir $deps;
        my $hashes = 0;
        for my $key (sort keys %groups) {
            my @paths = @{$groups{$key}};
            for my $area ('.fingerprint', 'build') {
                next if -l "$profile/$area";
                # Cargo fingerprints/build scripts use the package name, while
                # deps and incremental use the Rust target name.
                for my $crate (qw(octiq_flow_lib octiq_server octiq_notify octiq_job octiq octiq-flow)) {
                    my $metadata_key = "$crate-$key";
                    my $path = "$profile/$area/$metadata_key";
                    push @paths, $path if -e $path || -l $path;
                }
            }
            my $fresh = 0;
            for my $path (@paths) {
                walk($path, sub { $fresh = 1 if $_[1]->[9] >= $cutoff || -l $_[0]; });
            }
            next if $fresh;
            push @remove, @paths;
            $hashes++;
        }
        my $incrementals = 0;
        my $inc = "$profile/incremental";
        if (-d $inc && !-l $inc) {
            opendir my $id, $inc or die "$inc: $!";
            for my $entry (sort readdir $id) {
                next unless $entry =~ /^$own-[0-9a-z]+$/;
                my $path = "$inc/$entry";
                next unless -d $path && !-l $path;
                my $fresh = 0;
                walk($path, sub { $fresh = 1 if $_[1]->[9] >= $cutoff || -l $_[0]; });
                next if $fresh;
                push @remove, $path;
                $incrementals++;
            }
            closedir $id;
        }
        my %selected;
        @remove = grep { !$selected{$_}++ } @remove;
        # Estimate reclaimable blocks by inode, counting all links selected for
        # deletion together. Objects hard-linked to retained incremental dirs
        # free no space. Actual freed bytes always come from du before/after.
        my (%inodes, $candidate_bytes);
        $candidate_bytes = 0;
        for my $path (@remove) {
            walk($path, sub {
                my ($p, $s) = @_;
                return unless -f $p;
                my $key = "$s->[0]:$s->[1]";
                $inodes{$key} ||= [$s->[3], $s->[12] * 512, 0];
                $inodes{$key}->[2]++;
            });
        }
        for my $inode (values %inodes) {
            $candidate_bytes += $inode->[1] if $inode->[2] == $inode->[0];
        }
        unless ($dry) {
            for my $path (@remove) {
                if (-d $path && !-l $path) {
                    remove_tree($path, {error => \my $errors});
                    die "remove_tree failed for $path\n" if @$errors;
                } else {
                    unlink($path) or die "unlink $path: $!";
                }
            }
        }
        my $after = allocated($profile);
        printf "%s %s profile=%s hashes=%d incremental=%d candidate_file_bytes=%d before_bytes=%d after_bytes=%d freed_bytes=%d\n",
            strftime('%Y-%m-%d %H:%M:%S', localtime), $dry ? 'DRY-RUN' : 'PRUNED',
            $profile, $hashes, $incrementals, $candidate_bytes, $before, $after, $before - $after;
    }
}
PERL
