// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Wheelings
/// @notice On-chain pets that grow on Squeektoshi's real wheel. Each address can adopt one pet (free, soulbound).
/// While the hamster runs, owners cheer their pet for the current 10-minute round. Once SqueekCore settles that
/// round on Sepolia, the pet earns XP equal to the round's real wheel work, read straight from SqueekCore.
/// Unbroken cheered runs grow a streak bonus. The art is fully on-chain and changes with stage and mood.
/// @dev No owner, no admin, no upgrade, no ETH. The only external calls are view calls to SqueekCore and to the
/// Squeek collection (balanceOf, for the golden collar at adoption).

interface ISqueekCore {
    struct CoreState {
        uint64 settledThroughRound;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint64 blockHeight;
        uint96 blockProgress;
        uint32 workPerThousandBlocks;
        uint256 authorizationNonce;
        bool paused;
    }

    struct CoreConfiguration {
        bytes32 streamId;
        uint64 genesisTimestamp;
        uint64 roundDuration;
        uint64 maxWorkPerRound;
        uint16 maxRoundsPerBatch;
        address guardian;
        address reporter;
        uint32 initialWorkPerThousandBlocks;
        uint64 targetBlocksPerActiveRound;
        uint64 difficultySmoothingRounds;
        uint96 blockUnitsPerBlock;
    }

    struct LedgerPosition {
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint32 workPerThousandBlocks;
    }

    struct RoundCheckpoint {
        uint64 roundId;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint32 workPerThousandBlocks;
        bytes32 dataHash;
    }

    struct RoundPage {
        uint64 certifiedThroughRound;
        LedgerPosition start;
        LedgerPosition end;
        RoundCheckpoint[] rounds;
    }

    function state() external view returns (CoreState memory);
    function configuration() external view returns (CoreConfiguration memory);
    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords) external view returns (RoundPage memory);
}

interface IBalanceOf {
    function balanceOf(address owner) external view returns (uint256);
}

contract Wheelings {
    // ---------------------------------------------------------------- errors / events
    error AlreadyAdopted();
    error NotYourPet();
    error NoSuchPet();
    error Soulbound();
    error WheelNotStarted();
    error AlreadyCheered(uint64 round);
    error RoundSettled(uint64 round);
    error TooManyPending();
    error BadCorePage(uint64 round);
    error BadCore();
    error NothingToDrop();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId); // ERC-5192: every Wheeling is locked to its owner
    event Adopted(uint256 indexed id, address indexed owner, bool golden, uint64 round);
    event Cheered(uint256 indexed id, uint64 indexed round);
    event Resolved(uint256 indexed id, uint64 indexed round, uint64 work, uint64 xpGained, uint32 streak);
    event Dropped(uint256 indexed id, uint64 indexed round);
    event MetadataUpdate(uint256 _tokenId); // ERC-4906: art and traits changed

    // ---------------------------------------------------------------- config
    string public constant name = "Wheelings";
    string public constant symbol = "WHLG";
    uint256 public constant MAX_PENDING = 24;     // four hours of cheers can wait for settlement
    uint64 public constant DAY_ROUNDS = 144;      // 24 h of 10-minute rounds
    uint64 public constant STAGE_PUP = 1;
    uint64 public constant STAGE_RUNNER = 5_000;
    uint64 public constant STAGE_CHAMPION = 20_000;
    uint64 public constant STAGE_LEGEND = 60_000;

    ISqueekCore public immutable core;
    address public immutable squeeks;
    uint64 public immutable genesis;
    uint64 public immutable roundDuration;
    uint64 public immutable maxWork;

    // ---------------------------------------------------------------- state
    struct Pet {
        address owner;
        uint64 seed;
        uint64 born;        // round of adoption
        bool golden;        // owner held a Squeek at adoption
        uint64 xp;
        uint64 lastHit;     // last cheered round in which the wheel turned
        uint64 bestRound;   // most work in one cheered round
        uint32 cheers;
        uint32 hits;
        uint32 naps;
        uint32 streak;      // consecutive cheered rounds the wheel turned in
        uint32 bestStreak;
        uint64 lastCheer;   // newest cheered round
        uint64[] pending;   // cheered rounds waiting for settlement, ascending
    }

    uint256 public totalSupply;
    mapping(uint256 => Pet) private _pets;
    mapping(address => uint256) public petOf; // 0 = none
    mapping(address => bool) public adopted;  // one adoption per address, ever

    constructor(address core_, address squeeks_) {
        core = ISqueekCore(core_);
        squeeks = squeeks_;
        ISqueekCore.CoreConfiguration memory c = ISqueekCore(core_).configuration();
        if (c.roundDuration == 0 || c.genesisTimestamp == 0 || c.maxWorkPerRound == 0) revert BadCore();
        genesis = c.genesisTimestamp;
        roundDuration = c.roundDuration;
        maxWork = c.maxWorkPerRound;
    }

    // ---------------------------------------------------------------- rounds
    /// @notice The round in progress: round N ends at genesis + N * roundDuration.
    function currentRound() public view returns (uint64) {
        if (block.timestamp < genesis) return 0;
        return uint64((block.timestamp - genesis) / roundDuration) + 1;
    }

    function settledThroughRound() public view returns (uint64) {
        return core.state().settledThroughRound;
    }

    /// @notice Work the wheel did in one settled round, read from SqueekCore's certified round page.
    function roundWork(uint64 round) public view returns (uint64 work) {
        bool ok;
        (ok, work) = _readWork(round);
        if (!ok) revert BadCorePage(round);
    }

    /// @dev Never reverts. ok = false means "not readable yet": the round stays pending. A page that loads but looks
    /// odd is clamped (work above the core's max counts as the max, a backwards page counts as no work), so one bad
    /// round can never lock a pet.
    function _readWork(uint64 round) private view returns (bool ok, uint64 work) {
        if (round == 0) return (false, 0);
        try core.roundPage(round - 1, round, 1) returns (ISqueekCore.RoundPage memory p) {
            if (p.certifiedThroughRound < round) return (false, 0);
            if (p.end.cumulativeWork <= p.start.cumulativeWork) return (true, 0);
            work = p.end.cumulativeWork - p.start.cumulativeWork;
            if (work > maxWork) work = maxWork;
            return (true, work);
        } catch {
            return (false, 0);
        }
    }

    // ---------------------------------------------------------------- play
    /// @notice Adopt your Wheeling. Free; one per address; it cannot be transferred.
    function adopt() external returns (uint256 id) {
        if (adopted[msg.sender]) revert AlreadyAdopted();
        uint64 r = currentRound();
        if (r == 0) revert WheelNotStarted();
        adopted[msg.sender] = true;
        id = ++totalSupply;
        Pet storage p = _pets[id];
        p.owner = msg.sender;
        p.seed = uint64(uint256(keccak256(abi.encode(id, msg.sender, block.prevrandao, block.timestamp))));
        p.born = r;
        p.golden = _holdsSqueek(msg.sender);
        petOf[msg.sender] = id;
        emit Transfer(address(0), msg.sender, id);
        emit Locked(id);
        emit Adopted(id, msg.sender, p.golden, r);
    }

    /// @notice Cheer your pet on for the round in progress. If the wheel turns this round, your pet grows once
    /// SqueekCore settles it. Settled earlier cheers are scored first.
    function cheer(uint256 id) external {
        Pet storage p = _pet(id);
        if (p.owner != msg.sender) revert NotYourPet();
        uint64 r = currentRound();
        if (r == 0) revert WheelNotStarted();
        if (r <= p.lastCheer) revert AlreadyCheered(r);
        uint64 settled = _resolve(id, p);
        if (r <= settled) revert RoundSettled(r); // only a round still in progress can be cheered
        if (p.pending.length >= MAX_PENDING) revert TooManyPending();
        p.lastCheer = r;
        p.pending.push(r);
        ++p.cheers;
        emit Cheered(id, r);
    }

    /// @notice Score every cheered round SqueekCore has settled. Anyone may call it for any pet.
    function resolve(uint256 id) external {
        _resolve(id, _pet(id));
    }

    function _resolve(uint256 id, Pet storage p) private returns (uint64 settled) {
        settled = core.state().settledThroughRound;
        uint256 n = p.pending.length;
        if (n == 0) return settled;
        uint256 done;
        while (done < n && p.pending[done] <= settled) {
            uint64 r = p.pending[done];
            (bool ok, uint64 work) = _readWork(r);
            if (!ok) break; // SqueekCore can't serve this round yet: keep it (and everything after it) pending
            uint64 gained;
            if (work > 0) {
                p.streak = (p.lastHit != 0 && r == p.lastHit + 1) ? p.streak + 1 : 1;
                if (p.streak > p.bestStreak) p.bestStreak = p.streak;
                uint64 s = p.streak > 5 ? 5 : p.streak;
                gained = work + (work * (s - 1)) / 4; // up to 2x on a five-round run
                p.xp += gained;
                p.lastHit = r;
                ++p.hits;
                if (work > p.bestRound) p.bestRound = work;
            } else {
                p.streak = 0;
                ++p.naps;
            }
            emit Resolved(id, r, work, gained, p.streak);
            ++done;
        }
        if (done == 0) return settled;
        for (uint256 i = done; i < n; ++i) p.pending[i - done] = p.pending[i];
        for (uint256 i = 0; i < done; ++i) p.pending.pop();
        emit MetadataUpdate(id);
    }

    /// @notice Last resort for the owner: give up the oldest cheer if SqueekCore still can't serve that round a full
    /// day after settling it. It scores nothing (no XP, no nap) and frees the slot.
    function dropOldest(uint256 id) external {
        Pet storage p = _pet(id);
        if (p.owner != msg.sender) revert NotYourPet();
        uint256 n = p.pending.length;
        uint64 settled = core.state().settledThroughRound;
        if (n == 0 || p.pending[0] + DAY_ROUNDS > settled) revert NothingToDrop();
        uint64 r = p.pending[0];
        for (uint256 i = 1; i < n; ++i) p.pending[i - 1] = p.pending[i];
        p.pending.pop();
        emit Dropped(id, r);
    }

    // ---------------------------------------------------------------- views
    struct PetView {
        uint256 id;
        address owner;
        uint64 seed;
        uint64 born;
        bool golden;
        uint64 xp;
        uint8 stage;   // 0 egg, 1 pup, 2 runner, 3 champion, 4 legend
        uint8 mood;    // 0 happy, 1 hungry, 2 sleepy
        uint64 lastHit;
        uint64 bestRound;
        uint32 cheers;
        uint32 hits;
        uint32 naps;
        uint32 streak;
        uint32 bestStreak;
        uint64 lastCheer;
        uint64[] pending;
    }

    function pet(uint256 id) public view returns (PetView memory v) {
        Pet storage p = _pet(id);
        v.id = id;
        v.owner = p.owner;
        v.seed = p.seed;
        v.born = p.born;
        v.golden = p.golden;
        v.xp = p.xp;
        v.stage = stageOf(p.xp);
        v.mood = _mood(p);
        v.lastHit = p.lastHit;
        v.bestRound = p.bestRound;
        v.cheers = p.cheers;
        v.hits = p.hits;
        v.naps = p.naps;
        v.streak = p.streak;
        v.bestStreak = p.bestStreak;
        v.lastCheer = p.lastCheer;
        v.pending = p.pending;
    }

    /// @notice A page of pets for the board, ids start..start+count-1 (clipped to the supply).
    function pets(uint256 start, uint256 count) external view returns (PetView[] memory list) {
        if (start == 0) start = 1;
        if (start > totalSupply) return new PetView[](0);
        if (count > totalSupply) count = totalSupply;
        uint256 end = start + count;
        if (end > totalSupply + 1) end = totalSupply + 1;
        if (start >= end) return new PetView[](0);
        list = new PetView[](end - start);
        for (uint256 i = start; i < end; ++i) list[i - start] = pet(i);
    }

    function stageOf(uint64 xp) public pure returns (uint8) {
        if (xp >= STAGE_LEGEND) return 4;
        if (xp >= STAGE_CHAMPION) return 3;
        if (xp >= STAGE_RUNNER) return 2;
        if (xp >= STAGE_PUP) return 1;
        return 0;
    }

    function _mood(Pet storage p) private view returns (uint8) {
        uint64 now_ = currentRound();
        uint64 since = p.born;                       // the latest care: adoption, a cheer, or a scored run
        if (p.lastCheer > since) since = p.lastCheer;
        if (p.lastHit > since) since = p.lastHit;
        uint64 gap = now_ > since ? now_ - since : 0;
        if (gap <= DAY_ROUNDS) return 0;
        if (gap <= 3 * DAY_ROUNDS) return 1;
        return 2;
    }

    function _pet(uint256 id) private view returns (Pet storage p) {
        p = _pets[id];
        if (p.owner == address(0)) revert NoSuchPet();
    }

    function _holdsSqueek(address who) private view returns (bool) {
        if (squeeks.code.length == 0) return false;
        (bool ok, bytes memory ret) = squeeks.staticcall{gas: 50_000}(abi.encodeWithSelector(IBalanceOf.balanceOf.selector, who));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) > 0;
    }

    // ---------------------------------------------------------------- ERC-721 (soulbound)
    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert NoSuchPet();
        return petOf[owner] != 0 ? 1 : 0;
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _pet(id).owner;
    }

    function getApproved(uint256 id) external view returns (address) {
        _pet(id);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function locked(uint256 id) external view returns (bool) {
        _pet(id);
        return true;
    }

    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x01ffc9a7 // ERC-165
            || i == 0x80ac58cd // ERC-721
            || i == 0x5b5e139f // ERC-721 Metadata
            || i == 0xb45a3c0e  // ERC-5192 (soulbound)
            || i == 0x49064906; // ERC-4906 (metadata updates)
    }

    // ---------------------------------------------------------------- art
    function stageName(uint8 i) public pure returns (string memory) {
        return i == 0 ? "Egg" : i == 1 ? "Pup" : i == 2 ? "Runner" : i == 3 ? "Champion" : "Legend";
    }

    function moodName(uint8 i) public pure returns (string memory) {
        return i == 0 ? "Happy" : i == 1 ? "Hungry" : "Sleepy";
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        PetView memory v = pet(id);
        bytes memory json = abi.encodePacked(
            '{"name":"Wheeling #', _u(id),
            '","description":"An on-chain pet that grows on Squeektoshi\'s real wheel. It earns XP from the work of every settled SqueekCore round its owner cheered while the hamster ran.",',
            '"image":"data:image/svg+xml;base64,', _b64(bytes(_svg(v))), '","attributes":['
        );
        json = abi.encodePacked(json,
            '{"trait_type":"Stage","value":"', stageName(v.stage), '"},',
            '{"trait_type":"Mood","value":"', moodName(v.mood), '"},',
            '{"trait_type":"Collar","value":"', v.golden ? "Golden (Squeek holder)" : "Plain", '"},'
        );
        json = abi.encodePacked(json,
            '{"display_type":"number","trait_type":"XP","value":', _u(v.xp), '},',
            '{"display_type":"number","trait_type":"Runs cheered","value":', _u(v.hits), '},'
        );
        json = abi.encodePacked(json,
            '{"display_type":"number","trait_type":"Best streak","value":', _u(v.bestStreak), '},',
            '{"display_type":"number","trait_type":"Born in round","value":', _u(v.born), '}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _b64(json)));
    }

    function svgOf(uint256 id) external view returns (string memory) {
        return _svg(pet(id));
    }

    function _svg(PetView memory v) private pure returns (string memory) {
        uint256 s = v.seed;
        string[8] memory fur = ["#f2b35e", "#e8925a", "#d8c3a0", "#c98d6b", "#f0d9b5", "#b9a089", "#efa86a", "#e6c27a"];
        string[4] memory sky = ["#141c33", "#1b1838", "#10243a", "#20172b"];
        string memory f = fur[s % 8];
        string memory bg = sky[(s >> 8) % 4];
        bytes memory out = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><radialGradient id="g', _u(v.id), '" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#2b3a66"/><stop offset="1" stop-color="',
            bg, '"/></radialGradient></defs><rect width="400" height="400" fill="url(#g', _u(v.id), ')"/>',
            _stars(s),
            '<circle cx="330" cy="70" r="26" fill="#f6efd6" opacity=".9"/>',
            // the wheel behind the pet
            '<g opacity=".35" stroke="#ffc861" stroke-width="5" fill="none"><circle cx="200" cy="215" r="150"/><path d="M200 65v300M50 215h300M94 109l212 212M306 109L94 321"/></g>',
            '<ellipse cx="200" cy="350" rx="120" ry="16" fill="#000" opacity=".35"/>'
        );
        if (v.stage == 0) out = abi.encodePacked(out, _egg(f, v.golden));
        else out = abi.encodePacked(out, _body(v, f, s));
        out = abi.encodePacked(out,
            '<text x="20" y="34" font-family="monospace" font-size="18" fill="#ffc861">WHEELING #', _u(v.id), '</text>',
            '<rect y="364" width="400" height="36" fill="#0b0f1c" opacity=".55"/><text x="20" y="388" font-family="monospace" font-size="15" fill="#efe9dc">', STAGES_P(v.stage), ' - ', _u(v.xp), ' XP - ', MOODS_P(v.mood), '</text></svg>'
        );
        return string(out);
    }

    function STAGES_P(uint8 i) private pure returns (string memory) {
        return i == 0 ? "EGG" : i == 1 ? "PUP" : i == 2 ? "RUNNER" : i == 3 ? "CHAMPION" : "LEGEND";
    }

    function MOODS_P(uint8 i) private pure returns (string memory) {
        return i == 0 ? "HAPPY" : i == 1 ? "HUNGRY" : "SLEEPY";
    }

    function _stars(uint256 s) private pure returns (bytes memory out) {
        for (uint256 i = 0; i < 14; ++i) {
            uint256 h = uint256(keccak256(abi.encode(s, i)));
            out = abi.encodePacked(out, '<circle cx="', _u(h % 400), '" cy="', _u((h >> 16) % 180), '" r="', _u(1 + (h >> 32) % 2), '" fill="#fff" opacity=".7"/>');
        }
    }

    function _egg(string memory f, bool golden) private pure returns (bytes memory) {
        return abi.encodePacked(
            '<ellipse cx="200" cy="260" rx="70" ry="88" fill="#f4ecd8" stroke="#3a2a1a" stroke-width="4"/>',
            '<circle cx="175" cy="235" r="12" fill="', f, '"/><circle cx="222" cy="285" r="16" fill="', f, '"/><circle cx="230" cy="220" r="8" fill="', f, '"/>',
            golden ? '<path d="M150 330h100" stroke="#ffd54a" stroke-width="10" stroke-linecap="round"/>' : ''
        );
    }

    struct Geo {
        uint256 rx;   // body half-width, grows with the stage
        uint256 ry;
        uint256 top;  // top of the body
        uint256 eyeY;
        uint256 ear;  // ear style 0..2
        uint256 cy;   // body centre, rises as the pet grows
        string id;    // unique gradient id per pet
    }

    function _body(PetView memory v, string memory f, uint256 s) private pure returns (bytes memory out) {
        Geo memory g;
        g.rx = 70 + uint256(v.stage) * 10;
        g.ry = g.rx * 85 / 100;
        g.cy = 282 - uint256(v.stage) * 9;
        g.id = _u(v.id);
        g.top = g.cy - g.ry;
        g.eyeY = g.cy - g.ry * 22 / 100;
        g.ear = (s >> 16) % 3;
        out = abi.encodePacked(_ears(g, f), _torso(g, f, s));
        out = abi.encodePacked(out, _face(g, v.mood));
        out = abi.encodePacked(out, _gear(g, v.stage, v.golden));
    }

    function _el(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string memory fill, string memory extra) private pure returns (bytes memory) {
        return abi.encodePacked('<ellipse cx="', _u(cx), '" cy="', _u(cy), '" rx="', _u(rx), '" ry="', _u(ry), '" fill="', fill, '"', extra, '/>');
    }

    function _ears(Geo memory g, string memory f) private pure returns (bytes memory) {
        uint256 dx = g.rx * 58 / 100;
        uint256 ey = g.top + 14;
        uint256 erx = g.ear == 1 ? 18 + g.rx / 8 : 22 + g.rx / 7;
        uint256 ery = g.ear == 1 ? 30 + g.rx / 7 : 22 + g.rx / 7;
        uint256 irx = g.ear == 1 ? 9 + g.rx / 16 : 11 + g.rx / 14;
        uint256 iry = g.ear == 1 ? 17 + g.rx / 14 : 11 + g.rx / 14;
        string memory st = ' stroke="#3a2a1a" stroke-width="4"';
        return abi.encodePacked(
            _el(200 - dx, ey, erx, ery, f, st), _el(200 + dx, ey, erx, ery, f, st),
            _el(200 - dx, ey + 2, irx, iry, "#f7a8b8", ""), _el(200 + dx, ey + 2, irx, iry, "#f7a8b8", "")
        );
    }

    function _torso(Geo memory g, string memory f, uint256 s) private pure returns (bytes memory out) {
        string memory st = ' stroke="#3a2a1a" stroke-width="3"';
        out = abi.encodePacked(
            _el(200 - g.rx * 45 / 100, g.cy + g.ry - 8, 18, 11, "#f7a8b8", st),
            _el(200 + g.rx * 45 / 100, g.cy + g.ry - 8, 18, 11, "#f7a8b8", st),
            '<defs><radialGradient id="b', g.id, '" cx="38%" cy="30%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient></defs>',
            _el(200, g.cy, g.rx, g.ry, f, ' stroke="#3a2a1a" stroke-width="4"'),
            _el(200, g.cy + g.ry * 28 / 100, g.rx * 62 / 100, g.ry * 58 / 100, "#fbf1de", "")
        );
        out = abi.encodePacked(out, _el(200, g.cy, g.rx, g.ry, string(abi.encodePacked("url(#b", g.id, ")")), ""));
        uint256 pat = (s >> 24) % 3;
        if (pat == 1) {
            out = abi.encodePacked(out, '<path d="M', _u(200 - g.rx / 3), ' ', _u(g.top + 18), 'q', _u(g.rx / 3), ' -16 ', _u(g.rx * 2 / 3), ' 0" stroke="#3a2a1a" stroke-width="5" fill="none" opacity=".3"/>');
        } else if (pat == 2) {
            out = abi.encodePacked(out, _el(200 - g.rx * 62 / 100, g.cy - 10, 9, 9, "#3a2a1a", ' opacity=".2"'), _el(200 + g.rx * 64 / 100, g.cy - 18, 7, 7, "#3a2a1a", ' opacity=".2"'));
        }
    }

    function _face(Geo memory g, uint8 mood) private pure returns (bytes memory out) {
        uint256 l = 200 - g.rx * 26 / 100;
        uint256 r = 200 + g.rx * 26 / 100;
        uint256 y = g.eyeY;
        if (mood == 0) {
            out = abi.encodePacked(_el(l, y, 9, 9, "#1a1208", ""), _el(r, y, 9, 9, "#1a1208", ""), _el(l + 3, y - 3, 3, 3, "#fff", ""), _el(r + 3, y - 3, 3, 3, "#fff", ""));
            out = abi.encodePacked(out, '<path d="M192 ', _u(y + 24), 'q8 9 16 0" stroke="#1a1208" stroke-width="4" fill="none" stroke-linecap="round"/>');
        } else if (mood == 1) {
            out = abi.encodePacked(_el(l, y, 7, 7, "#1a1208", ""), _el(r, y, 7, 7, "#1a1208", ""));
            out = abi.encodePacked(out, '<path d="M192 ', _u(y + 30), 'q8-7 16 0" stroke="#1a1208" stroke-width="4" fill="none" stroke-linecap="round"/>');
            out = abi.encodePacked(out, '<path d="M', _u(200 + g.rx * 55 / 100), ' ', _u(y - 28), 'q9 13 0 20q-9-7 0-20z" fill="#7cc7ff"/>');
        } else {
            out = abi.encodePacked('<path d="M', _u(l - 9), ' ', _u(y), 'h18M', _u(r - 9), ' ', _u(y), 'h18" stroke="#1a1208" stroke-width="5" stroke-linecap="round"/>');
            out = abi.encodePacked(out, '<path d="M194 ', _u(y + 28), 'h12" stroke="#1a1208" stroke-width="4" stroke-linecap="round"/>');
            out = abi.encodePacked(out, '<text x="', _u(200 + g.rx * 70 / 100), '" y="', _u(g.top - 6), '" font-family="monospace" font-size="24" fill="#efe9dc">z Z</text>');
        }
        out = abi.encodePacked(out, _el(200, y + 16, 6, 5, "#e46a85", ""),
            _el(200 - g.rx * 45 / 100, y + 20, 10, 10, "#f59ab0", ' opacity=".55"'), _el(200 + g.rx * 45 / 100, y + 20, 10, 10, "#f59ab0", ' opacity=".55"'));
        out = abi.encodePacked(out, _whiskers(g));
    }

    function _whiskers(Geo memory g) private pure returns (bytes memory) {
        string memory a = _u(200 - g.rx * 22 / 100);
        string memory b = _u(200 + g.rx * 22 / 100);
        string memory len = _u(g.rx * 40 / 100);
        string memory y1 = _u(g.eyeY + 18);
        string memory y2 = _u(g.eyeY + 24);
        return abi.encodePacked(
            '<path d="M', a, ' ', y1, 'h-', len, 'M', a, ' ', y2, 'l-', len, ' 8M', b, ' ', y1, 'h', len,
            abi.encodePacked('M', b, ' ', y2, 'l', len, ' 8" stroke="#3a2a1a" stroke-width="2" opacity=".55"/>')
        );
    }

    function _gear(Geo memory g, uint8 stage, bool golden) private pure returns (bytes memory out) {
        if (stage >= 2) {
            out = abi.encodePacked('<path d="M', _u(200 - g.rx * 80 / 100), ' ', _u(g.top + g.ry * 30 / 100), 'Q200 ', _u(g.top - 4), ' ');
            out = abi.encodePacked(out, _u(200 + g.rx * 80 / 100), ' ', _u(g.top + g.ry * 30 / 100), '" stroke="#ff7a59" stroke-width="11" fill="none" stroke-linecap="round"/>');
        }
        if (stage >= 3) out = abi.encodePacked(out, '<path d="M', _u(200 - g.rx + 6), ' ', _u(g.cy + 20), 'l-38 46h46zM', _u(200 + g.rx - 6), ' ', _u(g.cy + 20), 'l38 46h-46z" fill="#7bd389" stroke="#3a2a1a" stroke-width="3"/>');
        if (stage >= 4) out = abi.encodePacked(out, '<path d="M168 ', _u(g.top - 2), 'l8-34 24 22 24-22 8 34z" fill="#ffd54a" stroke="#3a2a1a" stroke-width="3"/>', _el(200, g.top - 18, 5, 5, "#ff7a59", ""));
        if (golden) {
            out = abi.encodePacked(out, '<path d="M', _u(200 - g.rx * 50 / 100), ' ', _u(g.eyeY + 44), 'q', _u(g.rx * 50 / 100), ' 20 ', _u(g.rx), ' 0" stroke="#ffd54a" stroke-width="9" fill="none" stroke-linecap="round"/>');
            out = abi.encodePacked(out, _el(200, g.eyeY + 55, 8, 8, "#ffd54a", ' stroke="#3a2a1a" stroke-width="2"'));
        }
    }

    // ---------------------------------------------------------------- utils
    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    /// @dev Base64 encoding, adapted from OpenZeppelin Contracts (MIT), Base64.sol.
    function _b64(bytes memory data) private pure returns (string memory result) {
        if (data.length == 0) return "";
        string memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        result = new string(4 * ((data.length + 2) / 3));
        assembly ("memory-safe") {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 0x20)
            let dataPtr := data
            let endPtr := add(data, mload(data))
            let afterPtr := add(endPtr, 0x20)
            let afterCache := mload(afterPtr)
            mstore(afterPtr, 0x00)
            for {} lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }
            mstore(afterPtr, afterCache)
            switch mod(mload(data), 3)
            case 1 {
                mstore8(sub(resultPtr, 1), 0x3d)
                mstore8(sub(resultPtr, 2), 0x3d)
            }
            case 2 {
                mstore8(sub(resultPtr, 1), 0x3d)
            }
        }
    }
}
