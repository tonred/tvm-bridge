import { compile } from '@ton/blueprint';
import { Cell, Dictionary, toNano } from '@ton/core';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { TychoExecutor } from '@tychosdk/emulator';
import { SignatureParser } from '../wrappers/SignatureParser';

describe('SignatureParser', () => {
    let spCode: Cell;
    let blockchain: Blockchain;
    let signatureParser: SandboxContract<SignatureParser>;
    let executor: TychoExecutor;
    let deployer: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
        executor = await TychoExecutor.create();
        spCode = await compile('SignatureParser');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create({
            executor,
            config: TychoExecutor.defaultConfig,
        });
        deployer = await blockchain.treasury('deployer');
        signatureParser = blockchain.openContract(
            SignatureParser.createFromConfig(
                {
                    id: Math.floor(Math.random() * 10000),
                },
                spCode,
            ),
        );
        await signatureParser.sendDeploy(deployer.getSender(), toNano('1'));
    });

    it('should parse signatures data', async () => {
        const signatures = Cell.fromBase64(
            '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',
        );

        const res = await signatureParser.getSignaturesHash({
            signatures,
            rootHash: Buffer.from('b74123f8fff73a4fbcfe5d13e28a3966a272480d57a70660f30c391bfe577deb', 'hex'),
            fileHash: Buffer.from('a8580d19abb9cc7aebcb80db3f72854f79cf84dea939f6011f02c4ce2284d880', 'hex'),
        });

        console.log(res.hash.toString('base64'));

        expect(res.hash).toEqual(
            Buffer.from(
                '+D3jqF/9dvEWVxk7XdeWYzGBbL/03p3jjDuU4vCTNCh79OqPLAXhp0A/zZG2eQAAACb8ygZhqEtWpcEVytn12jDzR6qixlWduy8bZfOa0bfKAAAA',
                'base64',
            ),
        );
    });
});
