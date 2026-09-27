// Fluxer-authored DAVE delivery-service bindings (not upstream libdave code).
//
// These expose the server-side (delivery-service) operations that upstream
// libdave intentionally omits: external-sender credential management,
// key-package validation, external add/remove proposal creation, and
// commit/welcome parsing for roster tracking.
//
// The class holds NO group state — the Erlang gateway owns room state and
// passes everything needed per call. Compiled ONLY into the node WASM
// artefact (CMake option DAVE_DELIVERY=ON).
//
// Wire formats are chosen so that messages produced here are accepted
// unmodified by the client-side Session (see cpp/src/mls/session.cpp):
//   * Proposals bundle: tls(bool isRevoke=false) + tls(vector<MLSMessage>),
//     each MLSMessage a PublicMessage with SenderType::external created via
//     mlspp::external_proposal().
//   * External sender package: tls(mlspp::ExternalSender{signature_key,
//     credential}), matching Session::SetExternalSender.
//   * Commit parsing consumes the exact buffer Session::ProcessProposals
//     produces on clients: tls(MLSMessage commit) [tls(Welcome)].

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <mls/crypto.h>
#include <mls/messages.h>

#include "mls/util.h"

using namespace emscripten;

namespace discord {
namespace dave {
namespace delivery {

namespace {

constexpr ::mlspp::CipherSuite::ID kSuiteID =
  ::mlspp::CipherSuite::ID::P256_AES128GCM_SHA256_P256;

// Credential identity for the fluxer external sender (opaque to clients;
// they only compare it against the pinned package).
const char kExternalSenderIdentity[] = "FLUXER-DAVE-EXTERNAL-SENDER";

using ::mlspp::bytes_ns::bytes;

val ToOwned(const uint8_t* data, size_t size)
{
    val array = val::array();
    for (size_t i = 0; i < size; i++) {
        array.call<void>("push", data[i]);
    }
    return array;
}

val ToOwned(const bytes& data) { return ToOwned(data.data(), data.size()); }

bytes BytesFromJS(val array)
{
    std::vector<uint8_t> vec = emscripten::convertJSArrayToNumberVector<uint8_t>(array);
    return bytes(vec);
}

std::string HexEncode(const bytes& data)
{
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(data.size() * 2);
    for (uint8_t b : data) {
        out.push_back(digits[b >> 4]);
        out.push_back(digits[b & 0x0f]);
    }
    return out;
}

bytes HexDecode(const std::string& hex)
{
    if (hex.size() % 2 != 0) {
        throw std::invalid_argument("hex string has odd length");
    }
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9')
            return c - '0';
        if (c >= 'a' && c <= 'f')
            return c - 'a' + 10;
        if (c >= 'A' && c <= 'F')
            return c - 'A' + 10;
        throw std::invalid_argument("invalid hex character");
    };
    bytes out;
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        out.push_back(static_cast<uint8_t>((nibble(hex[i]) << 4) | nibble(hex[i + 1])));
    }
    return out;
}

std::string UserIdFromCredential(const ::mlspp::Credential& cred)
{
    if (cred.type() != ::mlspp::CredentialType::basic) {
        throw std::invalid_argument("credential is not a basic credential");
    }
    const auto& basic = cred.get<::mlspp::BasicCredential>();
    return std::to_string(::discord::dave::mls::FromBigEndianBytes(basic.identity));
}

val Fail(const std::string& reason)
{
    val out = val::object();
    out.set("ok", false);
    out.set("reason", reason);
    return out;
}

val Invalid(const std::string& reason)
{
    val out = val::object();
    out.set("valid", false);
    out.set("reason", reason);
    return out;
}

} // namespace

class DeliveryService {
public:
    DeliveryService()
      : suite_(kSuiteID)
    {
    }

    // Creates the deployment-wide external sender identity. The private key is
    // derived deterministically from the provided seed (mlspp HKDF-based
    // derivation), so every API instance with the same seed produces the same
    // identity and no persistence is strictly required.
    //
    // Returns { keyState: string (hex), senderPackage: number[] }
    // keyState format: hex(marshal(ExternalSender)) + ":" + hex(privateKey)
    val GenerateExternalSender(val seedBytes)
    {
        try {
            auto seed = BytesFromJS(seedBytes);
            if (seed.size() < 16) {
                throw std::invalid_argument("seed must be at least 16 bytes");
            }

            auto sigPriv = std::make_shared<::mlspp::SignaturePrivateKey>(
              ::mlspp::SignaturePrivateKey::derive(suite_, seed));

            std::string identStr(kExternalSenderIdentity);
            std::vector<uint8_t> identVec(identStr.begin(), identStr.end());
            auto sender = ::mlspp::ExternalSender{
              sigPriv->public_key,
              ::mlspp::Credential::basic(bytes(identVec)),
            };

            sigPriv_ = sigPriv;
            externalSender_ = std::make_unique<::mlspp::ExternalSender>(std::move(sender));

            val out = val::object();
            auto senderBytes = ::mlspp::tls::marshal(*externalSender_);
            out.set("keyState", HexEncode(senderBytes) + ":" + HexEncode(sigPriv->data));
            out.set("senderPackage", ToOwned(senderBytes));
            return out;
        }
        catch (const std::exception& e) {
            val out = val::object();
            out.set("error", std::string(e.what()));
            return out;
        }
    }

    // Loads an external sender identity produced by GenerateExternalSender.
    // Returns true on success.
    bool LoadExternalSender(const std::string& keyState)
    {
        try {
            auto colon = keyState.find(':');
            if (colon == std::string::npos) {
                throw std::invalid_argument("malformed key state");
            }

            auto senderBytes = HexDecode(keyState.substr(0, colon));
            auto privBytes = HexDecode(keyState.substr(colon + 1));

            auto sender = ::mlspp::tls::get<::mlspp::ExternalSender>(senderBytes);
            auto sigPriv = std::make_shared<::mlspp::SignaturePrivateKey>(
              ::mlspp::SignaturePrivateKey::parse(suite_, privBytes));

            if (!(sender.signature_key == sigPriv->public_key)) {
                throw std::invalid_argument("key state internal mismatch");
            }

            externalSender_ = std::make_unique<::mlspp::ExternalSender>(std::move(sender));
            sigPriv_ = std::move(sigPriv);
            return true;
        }
        catch (const std::exception& e) {
            (void)e;
            return false;
        }
    }

    bool HasExternalSender() const { return sigPriv_ != nullptr; }

    // The marshalled ExternalSender package (Opcode-25-style content handed to
    // clients via external_sender_package events).
    val ExternalSenderPackage()
    {
        if (!externalSender_) {
            return val::null();
        }
        return ToOwned(::mlspp::tls::marshal(*externalSender_));
    }

    // Validates a client-supplied MLS KeyPackage for membership binding.
    // Returns { valid: bool, reason: string }
    val ValidateKeyPackage(val keyPackageBytes, const std::string& expectedUserId)
    {
        try {
            auto raw = BytesFromJS(keyPackageBytes);
            auto kp = ::mlspp::tls::get<::mlspp::KeyPackage>(raw);

            if (kp.cipher_suite != suite_) {
                return Invalid("unsupported ciphersuite");
            }

            if (!kp.verify()) {
                return Invalid("key package signature invalid");
            }

            if (kp.leaf_node.credential.type() != ::mlspp::CredentialType::basic) {
                return Invalid("non-basic credential");
            }

            auto actualUserId = UserIdFromCredential(kp.leaf_node.credential);
            if (actualUserId != expectedUserId) {
                return Invalid("key package user ID does not match claimant");
            }

            if (!::mlspp::tls::var::holds_alternative<::mlspp::Lifetime>(kp.leaf_node.content)) {
                return Invalid("leaf node is not a lifetime-bearing node");
            }
            const auto& lifetime =
              ::mlspp::tls::var::get<::mlspp::Lifetime>(kp.leaf_node.content);
            if (lifetime.not_before != 0 || lifetime.not_after != UINT64_C(0xffffffffffffffff)) {
                return Invalid("unexpected key package lifetime");
            }

            if (!kp.leaf_node.verify(suite_, std::nullopt)) {
                return Invalid("leaf node signature invalid");
            }

            val out = val::object();
            out.set("valid", true);
            out.set("reason", std::string(""));
            return out;
        }
        catch (const std::exception& e) {
            return Invalid(std::string("malformed key package: ") + e.what());
        }
    }

    // Builds the bundled external proposals delivered to clients before a
    // commit is solicited. Adds are emitted before removes; the committer
    // applies them in this order (leftmost-free-leaf assignment follows).
    //
    // groupId: decimal snowflake string; epoch: current group epoch;
    // addKeyPackages / removeLeafIndices: JS arrays.
    // Returns the bundle bytes (client Session::ProcessProposals input), or
    // null on failure.
    val CreateProposals(const std::string& groupId,
                       uint32_t epoch,
                       val addKeyPackages,
                       val removeLeafIndices)
    {
        if (!sigPriv_) {
            return val::null();
        }

        try {
            auto gid = ::discord::dave::mls::BigEndianBytesFrom(std::stoull(groupId));
            auto messages = std::vector<::mlspp::MLSMessage>();

            auto adds = emscripten::vecFromJSArray<val>(addKeyPackages);
            for (const auto& kpVal : adds) {
                auto kpRaw = BytesFromJS(kpVal);
                auto kp = ::mlspp::tls::get<::mlspp::KeyPackage>(kpRaw);
                if (kp.cipher_suite != suite_) {
                    throw std::invalid_argument("add key package has wrong ciphersuite");
                }
                auto proposal = ::mlspp::Proposal{ ::mlspp::Add{ std::move(kp) } };
                messages.push_back(::mlspp::external_proposal(
                  suite_, gid, static_cast<::mlspp::epoch_t>(epoch), proposal, 0, *sigPriv_));
            }

            auto removes = emscripten::vecFromJSArray<uint32_t>(removeLeafIndices);
            for (auto leafIndex : removes) {
                auto proposal =
                  ::mlspp::Proposal{ ::mlspp::Remove{ ::mlspp::LeafIndex{ leafIndex } } };
                messages.push_back(::mlspp::external_proposal(
                  suite_, gid, static_cast<::mlspp::epoch_t>(epoch), proposal, 0, *sigPriv_));
            }

            if (messages.empty()) {
                return val::null();
            }

            auto out = ::mlspp::tls::ostream();
            out << false; // isRevoke
            out << messages;
            return ToOwned(out.bytes());
        }
        catch (const std::exception& e) {
            (void)e;
            return val::null();
        }
    }

    // Parses a commit(+welcome) blob relayed by a committing client, verifies
    // it covers exactly the pending external proposals we issued, and derives
    // the post-commit roster (user id -> leaf index) for gateway routing.
    //
    // commitWelcomeBundle: bytes from client Session::ProcessProposals output.
    // pendingProposals: the exact CreateProposals bundle bytes for this epoch.
    // knownRoster: JS array of {userId: string, leafIndex: number} for the
    //              pre-commit occupancy (empty for group founding).
    //
    // Returns { ok, reason?, newEpoch?, committerUserId?, roster?, welcome? }
    val ParseCommitWelcome(const std::string& groupId,
                          uint32_t expectedEpoch,
                          const std::string& committerUserId,
                          val commitWelcomeBundle,
                          val pendingProposals,
                          val knownRoster)
    {
        try {
            if (!externalSender_) {
                return Fail("no external sender loaded");
            }

            auto gid = ::discord::dave::mls::BigEndianBytesFrom(std::stoull(groupId));
            auto bundle = BytesFromJS(commitWelcomeBundle);
            auto pending = BytesFromJS(pendingProposals);

            // --- decode the commit (+ optional welcome) -------------------
            auto in = ::mlspp::tls::istream(bundle);
            auto commitMessage = ::mlspp::MLSMessage();
            in >> commitMessage;

            std::optional<bytes> welcomeBytes;
            if (!in.empty()) {
                auto welcome = ::mlspp::Welcome();
                in >> welcome;
                welcomeBytes = ::mlspp::tls::marshal(welcome);
            }

            if (!::mlspp::tls::var::holds_alternative<::mlspp::PublicMessage>(
                  commitMessage.message)) {
                return Fail("commit is not a public message");
            }
            const auto& publicMsg =
              ::mlspp::tls::var::get<::mlspp::PublicMessage>(commitMessage.message);
            const auto& groupContent = publicMsg.authenticated_content().content;

            if (groupContent.group_id != gid) {
                return Fail("commit is for a different group");
            }
            if (groupContent.epoch != static_cast<::mlspp::epoch_t>(expectedEpoch)) {
                return Fail("commit epoch mismatch");
            }
            if (groupContent.content_type() != ::mlspp::ContentType::commit) {
                return Fail("bundle does not contain a commit");
            }
            if (groupContent.sender.sender_type() != ::mlspp::SenderType::member) {
                return Fail("commit sender is not a member");
            }

            const auto& commit =
              ::mlspp::tls::var::get<::mlspp::Commit>(groupContent.content);

            // --- rebuild pending proposal metadata ----------------------
            auto pendingIn = ::mlspp::tls::istream(pending);
            bool isRevoke = true;
            pendingIn >> isRevoke;
            if (isRevoke) {
                return Fail("pending proposals bundle is a revocation");
            }
            auto pendingMessages = std::vector<::mlspp::MLSMessage>();
            pendingIn >> pendingMessages;

            struct PendingInfo {
                bool isAdd;
                std::string userId; // for adds
                uint32_t leafIndex; // for removes
            };
            auto pendingByRef = std::map<std::string, PendingInfo>();
            for (const auto& msg : pendingMessages) {
                const auto& pub = ::mlspp::tls::var::get<::mlspp::PublicMessage>(msg.message);
                const auto& ac = pub.authenticated_content();
                const auto& prop =
                  ::mlspp::tls::var::get<::mlspp::Proposal>(ac.content.content);
                auto refHex = HexEncode(suite_.ref(ac));
                if (prop.proposal_type() == ::mlspp::ProposalType::add) {
                    const auto& add = ::mlspp::tls::var::get<::mlspp::Add>(prop.content);
                    pendingByRef[refHex] = PendingInfo{
                        true, UserIdFromCredential(add.key_package.leaf_node.credential), 0
                    };
                }
                else if (prop.proposal_type() == ::mlspp::ProposalType::remove) {
                    const auto& rem =
                      ::mlspp::tls::var::get<::mlspp::Remove>(prop.content);
                    pendingByRef[refHex] = PendingInfo{ false, "", rem.removed.val };
                }
                else {
                    return Fail("unexpected pending proposal type");
                }
            }

            // --- shadow occupancy ---------------------------------------
            auto occupancy = std::map<uint32_t, std::string>();
            auto rosterArr = emscripten::vecFromJSArray<val>(knownRoster);
            for (const auto& entry : rosterArr) {
                auto leafIndex = entry["leafIndex"].as<uint32_t>();
                occupancy[leafIndex] = entry["userId"].as<std::string>();
            }

            // --- committer identity -------------------------------------
            auto committerLeaf =
              ::mlspp::tls::var::get<::mlspp::MemberSender>(groupContent.sender.sender);

            // The committer occupies their sender leaf. The gateway asserts the
            // committer's user identity from the authenticated WS sender (founding
            // commits carry no update_path, so it cannot be derived from the commit
            // alone). If a path is present, bind it to the claimed leaf and verify
            // its self-signature so a relayed blob cannot misattribute a path that
            // belongs to some other leaf.
            if (committerUserId.empty()) {
                return Fail("missing committer user id");
            }
            if (commit.path.has_value()) {
                // Update/commit-source leaves sign over a MemberBinding; verifying
                // with the live group id and sender leaf ties the path to this
                // exact group position instead of merely to a keypair.
                ::mlspp::LeafNode::MemberBinding binding{gid, committerLeaf.sender};
                if (!commit.path->leaf_node.verify(suite_, binding)) {
                    return Fail("commit path leaf node signature invalid");
                }
                auto pathUserId = UserIdFromCredential(commit.path->leaf_node.credential);
                if (pathUserId != committerUserId) {
                    return Fail("commit path identity does not match claimed committer");
                }
            }
            // The committer must already occupy the leaf they send from, unless
            // this is the founding commit (empty prior roster). Without this, a
            // relayed blob could reassign any leaf to any claimed identity.
            auto priorIt = occupancy.find(committerLeaf.sender.val);
            if (priorIt != occupancy.end() && priorIt->second != committerUserId) {
                return Fail("commit sender leaf is occupied by a different member");
            }
            occupancy[committerLeaf.sender.val] = committerUserId;

            // --- match and apply commit proposal references, in order ----
            // Clients process the commit's proposals in the order the committer
            // listed them; each Add takes the lowest free leaf at the moment it
            // is applied. Mirroring that here keeps the shadow roster identical
            // to the real tree — a committer reordering references (which would
            // shift every later leaf assignment) is rejected instead of being
            // silently mis-tracked, which could route future removals to the
            // wrong member.
            auto matchedRefs = std::set<std::string>();
            for (const auto& por : commit.proposals) {
                if (::mlspp::tls::variant<::mlspp::ProposalOrRefType>::type(por.content)
                    != ::mlspp::ProposalOrRefType::reference) {
                    return Fail("commit contains a by-value proposal");
                }
                const auto& ref = ::mlspp::tls::var::get<::mlspp::ProposalRef>(por.content);
                auto refHex = HexEncode(ref);
                auto it = pendingByRef.find(refHex);
                if (it == pendingByRef.end()) {
                    return Fail("commit references an unknown proposal");
                }
                if (!matchedRefs.insert(refHex).second) {
                    return Fail("commit references the same proposal twice");
                }
                if (it->second.isAdd) {
                    uint32_t candidate = 0;
                    while (occupancy.count(candidate) != 0) {
                        candidate++;
                    }
                    occupancy[candidate] = it->second.userId;
                }
                else {
                    occupancy.erase(it->second.leafIndex);
                }
            }
            if (matchedRefs.size() != pendingByRef.size()) {
                return Fail("commit does not cover all pending proposals");
            }

            // --- assemble result ----------------------------------------
            val rosterOut = val::array();
            for (const auto& [leafIndex, userId] : occupancy) {
                val entry = val::object();
                entry.set("userId", userId);
                entry.set("leafIndex", leafIndex);
                rosterOut.call<void>("push", entry);
            }

            val out = val::object();
            out.set("ok", true);
            out.set("newEpoch", expectedEpoch + 1);
            out.set("committerUserId", committerUserId);
            out.set("commit", ToOwned(::mlspp::tls::marshal(commitMessage)));
            out.set("roster", rosterOut);
            if (welcomeBytes.has_value()) {
                out.set("welcome", ToOwned(*welcomeBytes));
            }
            else {
                out.set("welcome", val::null());
            }
            return out;
        }
        catch (const std::exception& e) {
            return Fail(std::string("failed to parse commit: ") + e.what());
        }
    }

private:
    ::mlspp::CipherSuite suite_;
    std::shared_ptr<::mlspp::SignaturePrivateKey> sigPriv_;
    std::unique_ptr<::mlspp::ExternalSender> externalSender_;
};

} // namespace delivery
} // namespace dave
} // namespace discord

EMSCRIPTEN_BINDINGS(dave_delivery)
{
    class_<discord::dave::delivery::DeliveryService>("DaveDelivery")
      .constructor<>()
      .function("GenerateExternalSender",
                &discord::dave::delivery::DeliveryService::GenerateExternalSender)
      .function("LoadExternalSender",
                &discord::dave::delivery::DeliveryService::LoadExternalSender)
      .function("HasExternalSender",
                &discord::dave::delivery::DeliveryService::HasExternalSender)
      .function("ExternalSenderPackage",
                &discord::dave::delivery::DeliveryService::ExternalSenderPackage)
      .function("ValidateKeyPackage",
                &discord::dave::delivery::DeliveryService::ValidateKeyPackage)
      .function("CreateProposals",
                &discord::dave::delivery::DeliveryService::CreateProposals)
      .function("ParseCommitWelcome",
                &discord::dave::delivery::DeliveryService::ParseCommitWelcome);
}
