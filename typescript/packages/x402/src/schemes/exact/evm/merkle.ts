import { keccak256, encodePacked, Hex } from "viem";

export function generateMerkleRoot(leaves: Hex[]): Hex {
    if (leaves.length === 0) {
        return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }

    let level = leaves;

    while (level.length > 1) {
        const nextLevel: Hex[] = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 < level.length) {
                nextLevel.push(hashPair(level[i], level[i + 1]));
            } else {
                nextLevel.push(level[i]);
            }
        }
        level = nextLevel;
    }

    return level[0];
}

function hashPair(a: Hex, b: Hex): Hex {
    return keccak256(encodePacked(["bytes32", "bytes32"], [a, b]));
}

export function getLeaf(inputHash: Hex, outputHash: Hex): Hex {
    return keccak256(encodePacked(["bytes32", "bytes32"], [inputHash, outputHash]));
}
