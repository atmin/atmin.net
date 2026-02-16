import { describe, expect, it } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';

describe('Megolm', () => {
    describe('basic encrypt/decrypt', () => {
        it('roundtrips a message', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            const ct = sender.encrypt('Hey Alice');
            expect(receiver.decrypt(ct)).toBe('Hey Alice');

            sender.free();
            receiver.free();
        });

        it('session IDs match between sender and receiver', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            expect(receiver.session_id).toBe(sender.session_id);

            sender.free();
            receiver.free();
        });

        it('advances message index on each encrypt', () => {
            const sender = new MegolmOutbound();
            expect(sender.message_index).toBe(0);

            sender.encrypt('one');
            expect(sender.message_index).toBe(1);

            sender.encrypt('two');
            sender.encrypt('three');
            expect(sender.message_index).toBe(3);

            sender.free();
        });

        it('decrypts multiple messages in order', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            const messages = ['hello', 'how are you', 'goodbye'];
            for (const msg of messages) {
                const ct = sender.encrypt(msg);
                expect(receiver.decrypt(ct)).toBe(msg);
            }

            sender.free();
            receiver.free();
        });
    });

    describe('key backup (export/import)', () => {
        it('exports and imports a session for key backup', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            // Decrypt some messages first
            receiver.decrypt(sender.encrypt('msg 0'));
            receiver.decrypt(sender.encrypt('msg 1'));

            // Export for backup
            const exported = receiver.export_at_first_known_index();
            const restored = MegolmInbound.from_export(exported);

            // Restored session can decrypt new messages
            const ct = sender.encrypt('msg 2');
            expect(restored.decrypt(ct)).toBe('msg 2');

            sender.free();
            receiver.free();
            restored.free();
        });

        it('preserves first_known_index through export', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            expect(receiver.first_known_index).toBe(0);

            const exported = receiver.export_at_first_known_index();
            const restored = MegolmInbound.from_export(exported);

            expect(restored.first_known_index).toBe(0);
            expect(restored.session_id).toBe(sender.session_id);

            sender.free();
            receiver.free();
            restored.free();
        });
    });

    describe('multi-device (per-device sessions)', () => {
        it('two devices have different session IDs', () => {
            const device1 = new MegolmOutbound();
            const device2 = new MegolmOutbound();

            expect(device1.session_id).not.toBe(device2.session_id);

            device1.free();
            device2.free();
        });

        it("Bob decrypts from both of Alice's devices", () => {
            const laptop = new MegolmOutbound();
            const phone = new MegolmOutbound();

            const bobFromLaptop = MegolmInbound.from_session_key(
                laptop.session_key(),
            );
            const bobFromPhone = MegolmInbound.from_session_key(
                phone.session_key(),
            );

            expect(bobFromLaptop.decrypt(laptop.encrypt('from laptop'))).toBe(
                'from laptop',
            );
            expect(bobFromPhone.decrypt(phone.encrypt('from phone'))).toBe(
                'from phone',
            );

            laptop.free();
            phone.free();
            bobFromLaptop.free();
            bobFromPhone.free();
        });
    });

    describe('pickle (session persistence)', () => {
        it('outbound: pickle → from_pickle preserves state', () => {
            const sender = new MegolmOutbound();
            const sessionId = sender.session_id;

            sender.encrypt('msg 0');
            sender.encrypt('msg 1');
            expect(sender.message_index).toBe(2);

            const pickled = sender.pickle();
            sender.free();

            const restored = MegolmOutbound.from_pickle(pickled);
            expect(restored.session_id).toBe(sessionId);
            expect(restored.message_index).toBe(2);

            // Can continue encrypting
            const receiver = MegolmInbound.from_session_key(
                restored.session_key(),
            );
            const ct = restored.encrypt('msg 2');
            expect(receiver.decrypt(ct)).toBe('msg 2');
            expect(restored.message_index).toBe(3);

            restored.free();
            receiver.free();
        });

        it('inbound: pickle → from_pickle preserves state', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            // Decrypt one message
            const ct0 = sender.encrypt('msg 0');
            expect(receiver.decrypt(ct0)).toBe('msg 0');

            // Pickle and restore
            const pickled = receiver.pickle();
            const sessionId = receiver.session_id;
            receiver.free();

            const restored = MegolmInbound.from_pickle(pickled);
            expect(restored.session_id).toBe(sessionId);

            // Can decrypt next message
            const ct1 = sender.encrypt('msg 1');
            expect(restored.decrypt(ct1)).toBe('msg 1');

            sender.free();
            restored.free();
        });
    });

    describe('session key reflects ratchet position', () => {
        it('early share starts at index 0', () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );

            expect(receiver.first_known_index).toBe(0);

            sender.free();
            receiver.free();
        });

        it('late share starts at current index', () => {
            const sender = new MegolmOutbound();
            sender.encrypt('a');
            sender.encrypt('b');
            sender.encrypt('c');

            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );
            expect(receiver.first_known_index).toBe(3);

            // Can still decrypt new messages
            const ct = sender.encrypt('d');
            expect(receiver.decrypt(ct)).toBe('d');

            sender.free();
            receiver.free();
        });
    });
});
