import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { sha256_sync } from '@ton/crypto';
import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { LiteClient, Opcodes } from '../wrappers/LiteClient';
import { FeesTracker } from '../scripts/imports/utils/fees';
import {
    packEpochData,
    packSignatures,
    parseConfigParamValidators,
    parseEpochData,
} from '../scripts/imports/validators';
import { getConfigFromBlock, getSeqnoFromBlock, prepareKeyBlock } from '../scripts/imports/block';
import { TestData, TestnetTestData, TestnetTestDataTx } from './data';
import { convertToLibraryRef } from '../scripts/imports/utils/cell';
import { TychoExecutor } from '@tychosdk/emulator';
import { TransactionChecker } from '../wrappers/TransactionChecker';

function setLib(blockchain: Blockchain, lib: Cell) {
    let libsDict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    if (blockchain.libs) {
        libsDict = Dictionary.loadDirect(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell(), blockchain.libs!);
    }
    libsDict.set(lib.hash(), lib);
    blockchain.libs = beginCell().storeDictDirect(libsDict).endCell();
}

function getLib(blockchain: Blockchain, id: Buffer) {
    let libsDict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    if (blockchain.libs) {
        libsDict = Dictionary.loadDirect(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell(), blockchain.libs!);
    }
    return libsDict.get(id);
}

describe.each([[TestnetTestData, 0, 0]])('LiteClient', (testData: TestData[]) => {
    let lcCode: Cell;
    let checkerCode: Cell;
    let totalFees = new FeesTracker('Total');
    let liteClientFees = new FeesTracker('LiteClient');
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let liteClient: SandboxContract<LiteClient>;
    let txChecker: SandboxContract<TransactionChecker>;
    let verbosity = false;
    let executor: TychoExecutor;

    let setup: () => Promise<void>;

    const syncGenesysBlock = 0;
    afterAll(() => {
        totalFees.print();
        liteClientFees.print();
    });
    beforeAll(async () => {
        executor = await TychoExecutor.create();

        lcCode = await compile('LiteClient');
        checkerCode = await compile('TransactionChecker');

        setup = async () => {
            // blockchain = await Blockchain.create({})
            blockchain = await Blockchain.create({
                executor,
                config: TychoExecutor.defaultConfig,
            });
            if (verbosity) {
                blockchain.verbosity = {
                    print: true,
                    blockchainLogs: true,
                    vmLogs: 'vm_logs',
                    debugLogs: true,
                };
            }
            deployer = await blockchain.treasury('deployer');

            const genesysData = testData[syncGenesysBlock];
            const genesysBlock = Cell.fromBase64(genesysData.blockBoc);
            const genesysConfigCell = getConfigFromBlock(genesysBlock).get(34)!;
            const genesysConfig = parseConfigParamValidators(genesysConfigCell);

            let pastEpochs = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
            let epochData = packEpochData(genesysConfigCell);
            pastEpochs.set(genesysConfig.utimeSince, convertToLibraryRef(epochData));
            setLib(blockchain, epochData);

            const lcConfig = {
                currentEpochId: genesysConfig.utimeSince,
                pastEpochs: pastEpochs,
                id: Math.floor(Math.random() * 10000),
            };

            liteClient = blockchain.openContract(LiteClient.createFromConfig(lcConfig, lcCode));

            const lcDeployResult = await liteClient.sendDeploy(deployer.getSender(), toNano('0.01'));
            expect(lcDeployResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: liteClient.address,
                deploy: true,
                success: true,
            });
            const stateAfterDeploy = await liteClient.getState();
            expect(stateAfterDeploy.currentEpochSince).toBe(lcConfig.currentEpochId);
            const libs = Dictionary.loadDirect(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell(), blockchain.libs!);
            expect(libs.get(epochData.hash())).toEqualCell(epochData);
            const checkerConfig = {
                liteClient: liteClient.address,
            };
            txChecker = blockchain.openContract(TransactionChecker.createFromConfig(checkerConfig, checkerCode));
            const checkerDeployResult = await txChecker.sendDeploy(deployer.getSender(), toNano('0.1'));
            expect(checkerDeployResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: txChecker.address,
                deploy: true,
                success: true,
            });
        };
    });

    beforeEach(async () => {
        await setup();
    });

    it('should sync new key blocks', async () => {
        const syncer = await blockchain.treasury('key block syncer');
        for (let i = 1; i < testData.length; i++) {
            const nextTestData = testData[syncGenesysBlock + i];
            const nextKeyBlock = Cell.fromBase64(nextTestData.blockBoc);
            const nextKeyBlockSignatures = nextTestData.signatures;
            const nextKeyBlockFileHash = sha256_sync(Buffer.from(nextTestData.blockBoc, 'base64'));
            const nextSeqno = getSeqnoFromBlock(nextKeyBlock);
            const nextConfigCell = getConfigFromBlock(nextKeyBlock).get(34)!;
            const stateBefore = await liteClient.getState();
            const currentEpochDataCell = getLib(
                blockchain,
                stateBefore.currentEpochData.beginParse(true).skip(8).loadBuffer(32),
            );
            expect(currentEpochDataCell).not.toBeUndefined();
            const currentEpochData = parseEpochData(currentEpochDataCell!);
            const epochData = packEpochData(nextConfigCell);
            if (currentEpochDataCell?.equals(epochData)) {
                continue;
            }
            setLib(blockchain, epochData);
            const checkBlockResult = await liteClient.sendNewKeyBlock(syncer.getSender(), {
                value: toNano('0.1'),
                block: {
                    fileHash: nextKeyBlockFileHash,
                    blockProof: prepareKeyBlock(nextKeyBlock, true),
                },
                signatures: packSignatures(
                    nextKeyBlockSignatures,
                    currentEpochData.cutoffWeight,
                    currentEpochData.validatorsList,
                ),
            });
            totalFees.addManyTx(checkBlockResult.transactions);
            liteClientFees.addTxRaw(checkBlockResult.transactions[1].raw);
            expect(checkBlockResult.transactions).toHaveTransaction({
                from: syncer.address,
                to: liteClient.address,
                op: Opcodes.newKeyBlock,
                success: true,
            });
            console.log('Synced block ', i, ' ', nextSeqno);
        }
        for (const tx of TestnetTestDataTx) {
            const txHash = Buffer.from(tx.hash, 'hex');
            const r = await txChecker.sendCheckTransaction(syncer.getSender(), {
                value: toNano('0.1'),
                transaction: {
                    accountBlockId: Buffer.from(tx.addr.split(':')[1], 'hex'),
                    lt: BigInt(tx.lt),
                    hash: txHash,
                },
                proofChain: Cell.fromBase64(tx.proof_chain),
            });
            expect(r.transactions).toHaveTransaction({
                from: txChecker.address,
                to: syncer.address,
                op: 0x756adff1,
                success: true,
                body: beginCell().storeUint(0x756adff1, 32).storeBit(true).storeBuffer(txHash, 32).endCell(),
            });
            console.log('Checked tx ', tx.hash);
        }
    });
});
