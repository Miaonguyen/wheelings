// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./Wheelings.sol";
/// Test double of SqueekCore: per-round work set by the test, settled frontier set by the test.
contract MockCore {
    uint64 public genesis; uint64 public duration; uint64 public settled; uint64 public cum; bool public broken;
    mapping(uint64 => uint64) public cumAt; // cumulative work at the end of a round
    mapping(uint64 => uint64) public workOf;
    constructor(uint64 g, uint64 d) { genesis = g; duration = d; }
    function setWork(uint64 r, uint64 w) external { workOf[r] = w; }
    function settle(uint64 through) external { for (uint64 r = settled + 1; r <= through; r++) { cum += workOf[r]; cumAt[r] = cum; } settled = through; }
    function setBroken(bool b) external { broken = b; }
    function state() external view returns (ISqueekCore.CoreState memory s) { s.settledThroughRound = settled; s.cumulativeWork = cum; }
    function configuration() external view returns (ISqueekCore.CoreConfiguration memory c) { c.genesisTimestamp = genesis; c.roundDuration = duration; c.maxWorkPerRound = 10000; }
    function roundPage(uint64 afterRound, uint64 throughRound, uint256) external view returns (ISqueekCore.RoundPage memory p) {
        require(!broken, "core down");
        require(throughRound <= settled, "not settled");
        p.certifiedThroughRound = throughRound;
        p.start.cumulativeWork = afterRound == 0 ? 0 : cumAt[afterRound];
        p.end.cumulativeWork = cumAt[throughRound];
        if (workOf[throughRound] > 0) { p.rounds = new ISqueekCore.RoundCheckpoint[](1); p.rounds[0].roundId = throughRound; p.rounds[0].cumulativeWork = cumAt[throughRound]; }
    }
}
contract MockSqueeks { mapping(address => uint256) public balanceOf; function give(address a) external { balanceOf[a] = 1; } }
