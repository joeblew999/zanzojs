#!/usr/bin/env bash
# Integration test for workspace-d1 + workspace-d1-app.
#
# Architecture under test:
#   workspace-d1      (port 8787) — permission API: /grant /revoke /check /tuples /fs
#   workspace-d1-app  (port 8788) — HTTP surface: /files/* /ls/* /mv /cp /rmdir/*
#                                   calls workspace-d1 via Workers RPC (Service Binding)
#
# Run with: mise run workspace-d1-test
set -euo pipefail

PERM="http://localhost:8787"   # workspace-d1  — permission management
FS="http://localhost:8788"     # workspace-d1-app — filesystem HTTP surface (calls PERM via RPC)
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  PASS  $desc"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $desc"
    echo "        expected: $expected"
    echo "        got:      $actual"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "=== workspace-d1 integration tests ==="
echo ""

# ── Bootstrap — simulate Better Auth user signup ──────────────────────────────
# In production Better Auth fires a hook that grants each new user owner access
# to their root directory. We do it manually here via the permission API.
# Each user gets owner on their own directory ONLY — no cross-user inheritance.

echo "-- bootstrap --"

R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"User:alice","relation":"owner","type":"Directory","id":"/projects/demo"}')
check "bootstrap alice projects/demo" '"granted"' "$R"

R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"User:bob","relation":"owner","type":"Directory","id":"/home/bob"}')
check "bootstrap bob home" '"granted"' "$R"

# ── Filesystem ────────────────────────────────────────────────────────────────
# All FS calls hit workspace-d1-app (port 8788), which calls workspace-d1 via RPC.
# Permissions are enforced by PermissionedBackend inside workspace-d1.

echo ""
echo "-- filesystem --"

# Alice writes a file — onChange auto-grants owner tuple on the new file
R=$(curl -s -X PUT "$FS/files/projects/demo/notes.txt?actor=User:alice" -d "hello from alice")
check "alice writes file" '"written"' "$R"

# Alice writes a 2MB file — proves R2 spillover (files >~1.5MB go to R2)
python3 -c "import sys; sys.stdout.buffer.write(b'x' * 2097152)" > /tmp/zanzo-big.bin
R=$(curl -s -X PUT "$FS/files/projects/demo/big.bin?actor=User:alice" --data-binary @/tmp/zanzo-big.bin)
check "alice writes 2MB file (spills to R2)" '"written"' "$R"
echo "        2MB result: $R" | head -c 120
echo ""
rm -f /tmp/zanzo-big.bin

# Alice can read it
R=$(curl -s "$FS/files/projects/demo/notes.txt?actor=User:alice")
check "alice reads file" "hello from alice" "$R"

# Bob cannot read (no tuple yet)
R=$(curl -s "$FS/files/projects/demo/notes.txt?actor=User:bob")
check "bob denied before share" '"error"' "$R"

# Alice grants Bob viewer on the file (via permission API on workspace-d1)
R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"User:bob","relation":"viewer","type":"File","id":"/projects/demo/notes.txt"}')
check "alice grants bob viewer" '"granted"' "$R"

# Bob can now read
R=$(curl -s "$FS/files/projects/demo/notes.txt?actor=User:bob")
check "bob reads after grant" "hello from alice" "$R"

# Bob cannot write (viewer only)
R=$(curl -s -X PUT "$FS/files/projects/demo/notes.txt?actor=User:bob" -d "bob writes")
check "bob denied write" '"error"' "$R"

# Bob cannot delete (viewer only)
R=$(curl -s -X DELETE "$FS/files/projects/demo/notes.txt?actor=User:bob")
check "bob denied delete" '"error"' "$R"

# Alice deletes — onChange removes tuples
R=$(curl -s -X DELETE "$FS/files/projects/demo/notes.txt?actor=User:alice")
check "alice deletes file" '"deleted"' "$R"

# Alice reads after delete — file gone
R=$(curl -s "$FS/files/projects/demo/notes.txt?actor=User:alice")
check "alice read after delete is 404" '"error"' "$R"

# Bob reads after delete — tuple removed by onChange, denied
R=$(curl -s "$FS/files/projects/demo/notes.txt?actor=User:bob")
check "bob read after delete denied" '"error"' "$R"

# Alice lists her directory — should contain big.bin (notes.txt was deleted above)
R=$(curl -s "$FS/ls/projects/demo?actor=User:alice")
check "alice lists projects/demo" '"entries"' "$R"
check "alice ls contains big.bin" 'big.bin' "$R"

# Bob cannot list alice's directory (viewer was on file, not directory)
R=$(curl -s "$FS/ls/projects/demo?actor=User:bob")
check "bob denied ls projects/demo" '"error"' "$R"

# Bob can list his own home dir (empty but accessible)
R=$(curl -s "$FS/ls/home/bob?actor=User:bob")
check "bob lists home/bob" '"entries"' "$R"

# Alice cannot list bob's home dir
R=$(curl -s "$FS/ls/home/bob?actor=User:alice")
check "alice denied ls home/bob" '"error"' "$R"

# Carol has no tuples — denied write
R=$(curl -s -X PUT "$FS/files/projects/demo/intruder.txt?actor=User:carol" -d "hack")
check "carol denied write to alice dir" '"error"' "$R"

# Read a file that never existed (alice has dir access, file simply doesn't exist)
R=$(curl -s "$FS/files/projects/demo/ghost.txt?actor=User:alice")
check "alice read nonexistent file is 404" '"error"' "$R"

# ── exists / stat ────────────────────────────────────────────────────────────

echo ""
echo "-- exists / stat --"

# Alice can check existence of a file she owns
R=$(curl -s "$FS/exists/projects/demo/big.bin?actor=User:alice")
check "alice exists big.bin (true)" '"exists":true' "$R"

R=$(curl -s "$FS/exists/projects/demo/nope.txt?actor=User:alice")
check "alice exists nope.txt (false)" '"exists":false' "$R"

# Bob cannot check existence (no read permission)
R=$(curl -s "$FS/exists/projects/demo/big.bin?actor=User:bob")
check "bob denied exists" '"error"' "$R"

# Alice can stat a file
R=$(curl -s "$FS/stat/projects/demo/big.bin?actor=User:alice")
check "alice stat big.bin has size" '"size"' "$R"
check "alice stat big.bin is file type" '"file"' "$R"

# Bob cannot stat
R=$(curl -s "$FS/stat/projects/demo/big.bin?actor=User:bob")
check "bob denied stat" '"error"' "$R"

# ── mkdir ─────────────────────────────────────────────────────────────────────

echo ""
echo "-- mkdir --"

# Alice creates a new subdirectory
R=$(curl -s -X POST "$FS/mkdir/projects/demo/newdir?actor=User:alice")
check "alice mkdir newdir" '"created"' "$R"

# Verify it exists
R=$(curl -s "$FS/exists/projects/demo/newdir?actor=User:alice")
check "newdir exists after mkdir" '"exists":true' "$R"

# Bob cannot mkdir in alice's dir
R=$(curl -s -X POST "$FS/mkdir/projects/demo/bobdir?actor=User:bob")
check "bob denied mkdir in alice dir" '"error"' "$R"

# ── appendFile ────────────────────────────────────────────────────────────────

echo ""
echo "-- appendFile --"

# Alice writes then appends
R=$(curl -s -X PUT "$FS/files/projects/demo/log.txt?actor=User:alice" -d "line1")
check "alice writes log.txt" '"written"' "$R"

R=$(curl -s -X POST "$FS/append/projects/demo/log.txt?actor=User:alice" -d "
line2")
check "alice appends to log.txt" '"appended"' "$R"

R=$(curl -s "$FS/files/projects/demo/log.txt?actor=User:alice")
check "log.txt contains both lines" 'line2' "$R"

# Bob cannot append (viewer only granted earlier on notes.txt, not log.txt)
R=$(curl -s -X POST "$FS/append/projects/demo/log.txt?actor=User:bob")
check "bob denied append" '"error"' "$R"

# ── glob ─────────────────────────────────────────────────────────────────────

echo ""
echo "-- glob --"

# Alice can glob (owns root of her project dir)
R=$(curl -s "$FS/glob?pattern=projects/demo/**&actor=User:alice")
check "alice glob finds files" '"matches"' "$R"
check "alice glob includes log.txt" 'log.txt' "$R"

# Bob can also glob — glob returns paths only, not content. Content reads are still gated.
R=$(curl -s "$FS/glob?pattern=**/*&actor=User:bob")
check "bob can glob (paths only, no content)" '"matches"' "$R"

# ── copyDir / moveDir ─────────────────────────────────────────────────────────

echo ""
echo "-- copyDir / moveDir --"

# Setup: alice populates newdir
R=$(curl -s -X PUT "$FS/files/projects/demo/newdir/a.txt?actor=User:alice" -d "aaa")
check "alice writes newdir/a.txt" '"written"' "$R"

# Alice copies the whole dir
R=$(curl -s -X POST "$FS/cpdir?actor=User:alice" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/newdir","to":"/projects/demo/copydir"}')
check "alice copies directory" '"copied"' "$R"

# Verify copy has the file
R=$(curl -s "$FS/files/projects/demo/copydir/a.txt?actor=User:alice")
check "copydir/a.txt has correct content" 'aaa' "$R"

# Alice moves a dir
R=$(curl -s -X POST "$FS/mvdir?actor=User:alice" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/copydir","to":"/projects/demo/moveddir"}')
check "alice moves directory" '"moved"' "$R"

R=$(curl -s "$FS/files/projects/demo/moveddir/a.txt?actor=User:alice")
check "moveddir/a.txt has correct content" 'aaa' "$R"

R=$(curl -s "$FS/exists/projects/demo/copydir?actor=User:alice")
check "copydir gone after moveDir" '"exists":false' "$R"

# Bob cannot copyDir or moveDir
R=$(curl -s -X POST "$FS/cpdir?actor=User:bob" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/newdir","to":"/projects/demo/bobcopy"}')
check "bob denied copyDir" '"error"' "$R"

R=$(curl -s -X POST "$FS/mvdir?actor=User:bob" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/newdir","to":"/projects/demo/bobmove"}')
check "bob denied moveDir" '"error"' "$R"

# ── cp (copyFile) ─────────────────────────────────────────────────────────────
# cp needs read on src AND write on dest.

echo ""
echo "-- cp (copyFile) --"

# Setup: write a file alice will copy
R=$(curl -s -X PUT "$FS/files/projects/demo/original.txt?actor=User:alice" -d "original content")
check "alice writes original.txt for cp test" '"written"' "$R"

# Alice copies within her own dir (read on src + owner of dir = write on dest)
R=$(curl -s -X POST "$FS/cp?actor=User:alice" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/original.txt","to":"/projects/demo/copy.txt"}')
check "alice copies file" '"copied"' "$R"

# Verify copy exists and has right content
R=$(curl -s "$FS/files/projects/demo/copy.txt?actor=User:alice")
check "copied file has correct content" "original content" "$R"

# Bob has viewer on original — can read src but no write on dest dir, denied
R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"User:bob","relation":"viewer","type":"File","id":"/projects/demo/original.txt"}')
check "grant bob viewer on original.txt" '"granted"' "$R"

R=$(curl -s -X POST "$FS/cp?actor=User:bob" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/original.txt","to":"/projects/demo/bob-copy.txt"}')
check "bob denied cp (no write on dest)" '"error"' "$R"

# ── mv (moveFile) ─────────────────────────────────────────────────────────────
# mv needs delete on src AND write on dest.

echo ""
echo "-- mv (moveFile) --"

# Alice moves copy.txt to moved.txt (owns both paths)
R=$(curl -s -X POST "$FS/mv?actor=User:alice" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/copy.txt","to":"/projects/demo/moved.txt"}')
check "alice moves file" '"moved"' "$R"

# Verify moved file exists
R=$(curl -s "$FS/files/projects/demo/moved.txt?actor=User:alice")
check "moved file has correct content" "original content" "$R"

# Old path gone
R=$(curl -s "$FS/files/projects/demo/copy.txt?actor=User:alice")
check "old path gone after mv" '"error"' "$R"

# Bob (viewer on original.txt) cannot mv it — no delete permission
R=$(curl -s -X POST "$FS/mv?actor=User:bob" -H "Content-Type: application/json" \
  -d '{"from":"/projects/demo/original.txt","to":"/projects/demo/bob-moved.txt"}')
check "bob denied mv (no delete on src)" '"error"' "$R"

# ── deleteDir ─────────────────────────────────────────────────────────────────
# deleteDir needs delete on the Directory.

echo ""
echo "-- deleteDir --"

# Setup: alice creates a subdirectory with files
R=$(curl -s -X PUT "$FS/files/projects/demo/subdir/file1.txt?actor=User:alice" -d "file1")
check "alice writes subdir/file1.txt" '"written"' "$R"

R=$(curl -s -X PUT "$FS/files/projects/demo/subdir/file2.txt?actor=User:alice" -d "file2")
check "alice writes subdir/file2.txt" '"written"' "$R"

# Bob cannot delete alice's subdir
R=$(curl -s -X DELETE "$FS/rmdir/projects/demo/subdir?actor=User:bob")
check "bob denied deleteDir" '"error"' "$R"

# Carol (no tuples) cannot delete it either
R=$(curl -s -X DELETE "$FS/rmdir/projects/demo/subdir?actor=User:carol")
check "carol denied deleteDir" '"error"' "$R"

# Alice can delete her own subdir
R=$(curl -s -X DELETE "$FS/rmdir/projects/demo/subdir?actor=User:alice")
check "alice deletes subdir recursively" '"deleted"' "$R"

# Files inside are gone
R=$(curl -s "$FS/files/projects/demo/subdir/file1.txt?actor=User:alice")
check "file1.txt gone after deleteDir" '"error"' "$R"

# ── Generic permission API ────────────────────────────────────────────────────
# These use workspace-d1's /check /grant /revoke directly (port 8787).
# Actors: Agent:claude-mcp (MCP agent), User:gerard (drone operator)

echo ""
echo "-- generic permission API (CadModel, Drone, Project) --"

# Grant Agent:claude-mcp editor on CadModel:abc123
R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"Agent:claude-mcp","relation":"editor","type":"CadModel","id":"abc123"}')
check "grant agent editor on cadmodel" '"granted"' "$R"

# Agent can execute_command (editor grants it per schema)
R=$(curl -s "$PERM/check?actor=Agent:claude-mcp&action=execute_command&type=CadModel&id=abc123")
check "agent can execute_command" '"allowed":true' "$R"

# Agent cannot delete (only owner can)
R=$(curl -s "$PERM/check?actor=Agent:claude-mcp&action=delete&type=CadModel&id=abc123")
check "agent cannot delete" '"allowed":false' "$R"

# Grant User:gerard operator on Drone:123
R=$(curl -s -X PUT "$PERM/grant" -H "Content-Type: application/json" \
  -d '{"subject":"User:gerard","relation":"operator","type":"Drone","id":"123"}')
check "grant gerard operator on drone" '"granted"' "$R"

# Gerard can execute_command on drone
R=$(curl -s "$PERM/check?actor=User:gerard&action=execute_command&type=Drone&id=123")
check "gerard can execute drone command" '"allowed":true' "$R"

# Revoke agent editor
R=$(curl -s -X DELETE "$PERM/revoke" -H "Content-Type: application/json" \
  -d '{"subject":"Agent:claude-mcp","relation":"editor","type":"CadModel","id":"abc123"}')
check "revoke agent editor" '"revoked"' "$R"

# Agent can no longer execute
R=$(curl -s "$PERM/check?actor=Agent:claude-mcp&action=execute_command&type=CadModel&id=abc123")
check "agent denied after revoke" '"allowed":false' "$R"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== $PASS passed, $FAIL failed ==="
echo ""
[ "$FAIL" -eq 0 ]
