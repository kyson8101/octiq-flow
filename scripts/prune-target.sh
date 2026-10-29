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
# Perl is shipped by macOS. One metadata pass avoids spawning stat/find once
# per CGU object (there can be tens of thousands). No symlinks are followed.
/usr/bin/perl - "$days" "$dry_run" "$worktrees" "$REPO" ${targets[@]+"${targets[@]}"} <<'PERL'
use strict;
use warnings;
use File::Find ();
use File::Path qw(remove_tree);
use POSIX qw(strftime);
use Cwd qw(abs_path getcwd);
my ($days, $dry, $worktrees, $repo, @targets) = @ARGV;
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
# Inspect the original spelling before canonicalization: -l on a final
# component misses ancestors and even a final symlink with a trailing slash.
sub skipped {
    my ($path) = @_;
    print strftime("%Y-%m-%d %H:%M:%S", localtime), " SKIPPED path=$path (missing, symlink or redirected path)\n";
    return;
}
sub verified_dir {
    my ($path) = @_;
    $path =~ s{/+$}{};
    $path = '/' if $path eq '';
    $path = getcwd() . "/$path" unless $path =~ m{^/};
    my ($walk, @parts) = ('');
    for my $part (split m{/+}, $path) {
        next if $part eq '' || $part eq '.';
        $walk .= "/$part";
        my @st = lstat($walk);
        return skipped($path) unless @st && -d _ && !-l _;
        if ($part eq '..') { pop @parts; } else { push @parts, $part; }
    }
    my $lexical = '/' . join('/', @parts);
    my $real = abs_path($path);
    return skipped($path) unless defined $real && $real eq $lexical;
    return $lexical;
}
sub children {
    my ($dir) = @_;
    opendir my $dh, $dir or die "$dir: $!";
    my @names = sort grep { $_ ne '.' && $_ ne '..' } readdir $dh;
    closedir $dh;
    return map { "$dir/$_" } @names;
}
if ($worktrees) {
    # Validate listed roots and every sibling level BEFORE descending. This
    # includes leftover worktrees, without traversing symlinked siblings.
    open my $git, '-|', 'git', '-c', 'core.quotePath=false', '-C', $repo,
        'worktree', 'list', '--porcelain' or die "git: $!";
    my @roots;
    while (<$git>) { chomp; push @roots, $1 if /^worktree (.*)$/; }
    close $git or die "git worktree list failed\n";
    my %bases;
    for my $root (@roots) {
        my $verified = verified_dir($root);
        next unless defined $verified;
        push @targets, "$verified/src-tauri/target";
        if ($root =~ m{^(.*?/\.worktrees/[^/]+)/[^/]+/[^/]+$}) {
            my $base = verified_dir($1);
            next unless defined $base && !$bases{$base}++;
            for my $group (children($base)) {
                next unless -d $group || -l $group;
                $group = verified_dir($group);
                next unless defined $group;
                for my $sibling (children($group)) {
                    next unless -d $sibling || -l $sibling;
                    $sibling = verified_dir($sibling);
                    next unless defined $sibling;
                    push @targets, "$sibling/src-tauri/target";
                }
            }
        }
    }
}
push @targets, "$repo/src-tauri/target" unless @targets || $worktrees;
for my $supplied (@targets) {
    my $target = verified_dir($supplied);
    next unless defined $target;
    next if $seen{$target}++;
    opendir my $td, $target or die "$target: $!";
    my @profiles = sort grep { $_ ne '.' && $_ ne '..' } readdir $td;
    closedir $td;
    for my $name (@profiles) {
        my $profile = "$target/$name";
        next unless -d $profile || -l $profile;
        next unless defined verified_dir($profile);
        my $safe = 1;
        for my $area (qw(deps incremental .fingerprint build)) {
            my $path = "$profile/$area";
            next unless -e $path || -l $path;
            $safe = 0 unless defined verified_dir($path);
        }
        next unless $safe && -d "$profile/deps";
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
                # Revalidate ancestors and containment immediately before every
                # removal, even though selection already checked these paths.
                my $parent = $path;
                $parent =~ s{/[^/]+$}{};
                next unless defined verified_dir($parent);
                my $real = abs_path($path);
                unless (defined $real && index($real, "$target/") == 0 && !-l $path) {
                    skipped($path);
                    next;
                }
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
