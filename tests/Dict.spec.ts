import { Blockchain, printTransactionFees, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { DictTest } from '../wrappers/DictTest';
import seedrandom, { PRNG } from 'seedrandom';
import { FeesTracker } from '../scripts/imports/utils/fees';
import { ErrorCodes } from '../wrappers/TransactionChecker';

const SEED = 'ton-trustless-bridge';

describe('DictTest', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let contract: SandboxContract<DictTest>;
    const verbosity = false;

    beforeAll(async () => {
        code = await compile('DictTest');
        blockchain = await Blockchain.create();
        if (verbosity) {
            blockchain.verbosity = {
                print: true,
                blockchainLogs: true,
                vmLogs: 'vm_logs',
                debugLogs: true,
            };
        }
        deployer = await blockchain.treasury('deployer');
        contract = blockchain.openContract(DictTest.createFromConfig(code));
        const deployResult = await contract.sendDeploy(deployer.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: contract.address,
            deploy: true,
            success: true,
        });
    });

    it('default', async () => {
        /*
        C_                  1
          C8                [same]  11 0   01000
            62_             [short] 0  110 00
              A68054C_      [long]  10 100 1101     0000000010101001 (=169)
              A08090C_      [long]  10 100 0001     0000000100100001 (=289)
            BEFDF21         [long]  10 111 1101111  1101111100100001 (=57121)

        Fees:
        - 13:   0.001531
        - 17:   0.001531
        - 239:  0.001185
        - fees:	0.004245200
        */
        const data = [
            [13n, 169n],
            [17n, 289n],
            [239n, 57121n],
        ];
        const fees = await run(data, 16, 16, false, true);
        fees.print();
    });

    it('flipped', async () => {
        // the same as default, but bits are flipped
        const data = [
            [65522n, 65366n],
            [65518n, 65246n],
            [65296n, 8414n],
        ];
        const fees = await run(data, 16, 16, false, true);
        fees.print();
    });

    it('one value', async () => {
        const rng = seedrandom(SEED);
        const data = [[random(rng, 16), random(rng, 16)]];
        const fees = await run(data, 16, 16, false, true);
        fees.print();
    });

    it('two values', async () => {
        const rng = seedrandom(SEED);
        const data = [
            [0n, random(rng, 16)],
            [65535n, random(rng, 16)],
        ];
        const fees = await run(data, 16, 16, false, true);
        fees.print();
    });

    it('complete tree', async () => {
        // fees: 0.893849600
        const data: bigint[][] = [];
        for (let i = 0; i < 256; i++) {
            const bi = BigInt(i);
            data.push([bi, bi]);
        }
        const fees = await run(data, 8, 8);
        fees.print();
    });

    it.skip.each([
        [512, 16, 256], // fees: 2.053398000 | 44 sec
        [512, 64, 256], // fees: 2.044957600 | 45 sec
        [512, 256, 256], // fees: 2.060378800 | 53 sec
    ])('random slow %d of %d:%d', async (size: number, keyBits: number, valueBits: number) => {
        const rng = seedrandom(SEED);
        const data = randomDictData(rng, size, keyBits, valueBits);
        const fees = await run(data, keyBits, valueBits);
        fees.print();
    });

    it.each([
        [16, 256], // fees (last): 4.241719600
        [64, 256], // fees (last): 4.235042000
        [256, 256], // fees (last): 4.245138800
    ])('random fast 128..1024 of %d:%d', async (keyBits: number, valueBits: number) => {
        const rng = seedrandom(SEED);
        for (let size = 128; size <= 1024; size += 128) {
            const data = randomDictData(rng, size, keyBits, valueBits);
            const fees = await run(data, keyBits, valueBits, true, true);
            fees.print();
        }
    });

    it.each([
        [16, 256], // fees (last): 14.339309200
        [64, 256], // fees (last): 14.342000400
        [256, 256], // fees (last): 14.330548000
    ])('random fast 2048, 3072 of %d:%d', async (keyBits: number, valueBits: number) => {
        const rng = seedrandom(SEED);
        for (let size of [2048, 3072]) {
            const data = randomDictData(rng, size, keyBits, valueBits);
            const fees = await run(data, keyBits, valueBits, true, true);
            fees.print();
        }
    });

    it('not found', async (size: number = 256, keyBits: number = 16, valueBits: number = 16) => {
        const rng = seedrandom(SEED);
        const key = random(rng, keyBits);
        let data: bigint[][];
        do {
            data = randomDictData(rng, size, keyBits, valueBits);
        } while (data.find((item) => item[0] === key));

        const dict = createDict(data, keyBits, valueBits);
        const keyCell = beginCell().storeUint(key, keyBits).endCell();
        const valueCell = beginCell().storeUint(0, valueBits).endCell();
        const result = await contract.sendTestOne(deployer.getSender(), {
            value: toNano('0.05'),
            dict: dict,
            key: keyCell,
            expected: valueCell,
        });
        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: contract.address,
            success: false,
            exitCode: ErrorCodes.KeyNotFound,
        });
        printTransactionFees(result.transactions);
    });

    async function run(
        data: bigint[][],
        keyBits: number,
        valueBits: number,
        fast: boolean = false,
        print: boolean = false,
    ): Promise<FeesTracker> {
        const dict = createDict(data, keyBits, valueBits);
        let fees = new FeesTracker('Total');
        if (fast) {
            const result = await contract.sendTestFull(deployer.getSender(), {
                value: toNano(0.05 * data.length),
                keyBits: keyBits,
                dict: dict,
            });
            processResult(result, fees, print);
        } else {
            for (const [key, value] of data) {
                const keyCell = beginCell().storeUint(key, keyBits).endCell();
                const valueCell = beginCell().storeUint(value, valueBits).endCell();
                const result = await contract.sendTestOne(deployer.getSender(), {
                    value: toNano('0.05'),
                    dict: dict,
                    key: keyCell,
                    expected: valueCell,
                });
                processResult(result, fees, print);
            }
        }
        return fees;
    }

    function createDict(data: bigint[][], keyBits: number, valueBits: number): Cell {
        let raw = Dictionary.empty(Dictionary.Keys.BigUint(keyBits), Dictionary.Values.BigUint(valueBits));
        for (const [key, value] of data) {
            raw.set(key, value);
        }
        return beginCell().storeDictDirect(raw).endCell();
    }

    function processResult(result: SendMessageResult, fees: FeesTracker, print: boolean = false) {
        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: contract.address,
            success: true,
        });
        fees.addManyTx(result.transactions.slice(1));
        if (print) {
            printTransactionFees(result.transactions);
        }
    }

    function randomDictData(rng: PRNG, size: number, keyBits: number, valueBits: number): bigint[][] {
        const keys = new Set<bigint>();
        const matrix: bigint[][] = [];
        for (let i = 0; i < size; i++) {
            const key = random(rng, keyBits);
            if (keys.has(key)) {
                i--;
                continue;
            }
            keys.add(key);
            const value = random(rng, valueBits);
            matrix.push([key, value]);
        }
        return matrix;
    }

    function random(rng: PRNG, bits: number): bigint {
        let result = BigInt(0);
        for (let i = 0; i < bits / 8; i++) {
            const byte = Math.floor(rng() * 256);
            result = (result << BigInt(8)) | BigInt(byte);
        }
        return result;
    }
});
