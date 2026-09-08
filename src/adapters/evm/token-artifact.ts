// GENERATED FILE - do not edit by hand.
// Source: contracts/src/InstitutionalToken.sol
// Regenerate with: pnpm contracts:sync

export const institutionalTokenAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "name_",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "symbol_",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "decimals_",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "supplyCap_",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "admin_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "minter_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "complianceOfficer_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pauser_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "COMPLIANCE_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DEFAULT_ADMIN_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MINTER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "PAUSER_ROLE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowance",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "approve",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "decimals",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "eligibleUntil",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "eligibleUntil",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRoleAdmin",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "grantRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "hasRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isEligible",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mintWithReference",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "operationReference",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "name",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "referenceConsumed",
    "inputs": [
      {
        "name": "operationReference",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "consumed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "callerConfirmation",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "revokeRole",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setEligibility",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "eligibleUntilTimestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "supplyCap",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "symbol",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "totalSupply",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transfer",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferFrom",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "unpause",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Approval",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "spender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EligibilityUpdated",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "eligibleUntil",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MintExecuted",
    "inputs": [
      {
        "name": "operationReference",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newTotalSupply",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Paused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleAdminChanged",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "previousAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "newAdminRole",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleGranted",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoleRevoked",
    "inputs": [
      {
        "name": "role",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Transfer",
    "inputs": [
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "value",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Unpaused",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccessControlBadConfirmation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AccessControlUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "neededRole",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientAllowance",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InsufficientBalance",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "balance",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "needed",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidApprover",
    "inputs": [
      {
        "name": "approver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidReceiver",
    "inputs": [
      {
        "name": "receiver",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSender",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ERC20InvalidSpender",
    "inputs": [
      {
        "name": "spender",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidOperationReference",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidRecipient",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidSupplyCap",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MintDeadlineExpired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "blockTimestamp",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "OperationReferenceAlreadyConsumed",
    "inputs": [
      {
        "name": "operationReference",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "RecipientEligibilityExpired",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "eligibleUntilTimestamp",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "RecipientNotEligible",
    "inputs": [
      {
        "name": "recipient",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SupplyCapExceeded",
    "inputs": [
      {
        "name": "requested",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "totalSupplyNow",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "cap",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  }
] as const;

export const institutionalTokenBytecode =
  '0x60c060405234801561000f575f5ffd5b506040516117b73803806117b783398101604081905261002e916102e7565b8787600361003c8382610432565b5060046100498282610432565b50506005805460ff19169055505f8590036100775760405163606bb6c960e11b815260040160405180910390fd5b6001600160a01b0384166100ad57604051630bc2c5df60e11b81526001600160a01b038516600482015260240160405180910390fd5b608085905260ff861660a0526100c35f85610182565b506001600160a01b038316156100ff576100fd7f9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a684610182565b505b6001600160a01b0382161561013a576101387f442a94f1a1fac79af32856af2a64f63648cfa2ef3b98610a5bb7cbec4cee698583610182565b505b6001600160a01b03811615610175576101737f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a82610182565b505b50505050505050506104ec565b5f8281526006602090815260408083206001600160a01b038516845290915281205460ff16610226575f8381526006602090815260408083206001600160a01b03861684529091529020805460ff191660011790556101de3390565b6001600160a01b0316826001600160a01b0316847f2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d60405160405180910390a4506001610229565b505f5b92915050565b634e487b7160e01b5f52604160045260245ffd5b5f82601f830112610252575f5ffd5b81516001600160401b0381111561026b5761026b61022f565b604051601f8201601f19908116603f011681016001600160401b03811182821017156102995761029961022f565b6040528181528382016020018510156102b0575f5ffd5b8160208501602083015e5f918101602001919091529392505050565b80516001600160a01b03811681146102e2575f5ffd5b919050565b5f5f5f5f5f5f5f5f610100898b0312156102ff575f5ffd5b88516001600160401b03811115610314575f5ffd5b6103208b828c01610243565b60208b015190995090506001600160401b0381111561033d575f5ffd5b6103498b828c01610243565b975050604089015160ff8116811461035f575f5ffd5b60608a0151909650945061037560808a016102cc565b935061038360a08a016102cc565b925061039160c08a016102cc565b915061039f60e08a016102cc565b90509295985092959890939650565b600181811c908216806103c257607f821691505b6020821081036103e057634e487b7160e01b5f52602260045260245ffd5b50919050565b601f82111561042d57805f5260205f20601f840160051c8101602085101561040b5750805b601f840160051c820191505b8181101561042a575f8155600101610417565b50505b505050565b81516001600160401b0381111561044b5761044b61022f565b61045f8161045984546103ae565b846103e6565b6020601f821160018114610491575f831561047a5750848201515b5f19600385901b1c1916600184901b17845561042a565b5f84815260208120601f198516915b828110156104c057878501518255602094850194600190920191016104a0565b50848210156104dd57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b60805160a05161129c61051b5f395f61029d01525f818161038a015281816107de015261082a015261129c5ff3fe608060405234801561000f575f5ffd5b50600436106101bb575f3560e01c806370a08231116100f3578063a77c2b7411610093578063d53913931161006e578063d539139314610416578063d547741f1461043d578063dd62ed3e14610450578063e63ab1e914610488575f5ffd5b8063a77c2b74146103ce578063a9059cbb146103f0578063afebef9714610403575f5ffd5b80638f770ad0116100ce5780638f770ad01461038557806391d14854146103ac57806395d89b41146103bf578063a217fddf146103c7575f5ffd5b806370a08231146103135780637cedebc51461033b5780638456cb591461037d575f5ffd5b80632f2ff15d1161015e5780633d37aa06116101395780633d37aa06146102da5780633f4ba83a146102ed5780635c975abb146102f557806366e305fd14610300575f5ffd5b80632f2ff15d14610281578063313ce5671461029657806336568abe146102c7575f5ffd5b8063095ea7b311610199578063095ea7b31461023157806318160ddd1461024457806323b872dd1461024c578063248a9ca31461025f575f5ffd5b806301ffc9a7146101bf578063062d3bd7146101e757806306fdde031461021c575b5f5ffd5b6101d26101cd366004611032565b6104af565b60405190151581526020015b60405180910390f35b61020e7f442a94f1a1fac79af32856af2a64f63648cfa2ef3b98610a5bb7cbec4cee698581565b6040519081526020016101de565b6102246104e5565b6040516101de9190611059565b6101d261023f3660046110a9565b610575565b60025461020e565b6101d261025a3660046110d1565b61058c565b61020e61026d36600461110b565b5f9081526006602052604090206001015490565b61029461028f366004611122565b6105af565b005b60405160ff7f00000000000000000000000000000000000000000000000000000000000000001681526020016101de565b6102946102d5366004611122565b6105d9565b6102946102e8366004611163565b610611565b6102946108cf565b60055460ff166101d2565b6101d261030e3660046111a6565b610904565b61020e6103213660046111a6565b6001600160a01b03165f9081526020819052604090205490565b6103646103493660046111a6565b60076020525f908152604090205467ffffffffffffffff1681565b60405167ffffffffffffffff90911681526020016101de565b610294610946565b61020e7f000000000000000000000000000000000000000000000000000000000000000081565b6101d26103ba366004611122565b610978565b6102246109a2565b61020e5f81565b6101d26103dc36600461110b565b60086020525f908152604090205460ff1681565b6101d26103fe3660046110a9565b6109b1565b6102946104113660046111bf565b6109be565b61020e7f9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a681565b61029461044b366004611122565b610a88565b61020e61045e3660046111e7565b6001600160a01b039182165f90815260016020908152604080832093909416825291909152205490565b61020e7f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a81565b5f6001600160e01b03198216637965db0b60e01b14806104df57506301ffc9a760e01b6001600160e01b03198316145b92915050565b6060600380546104f49061120f565b80601f01602080910402602001604051908101604052809291908181526020018280546105209061120f565b801561056b5780601f106105425761010080835404028352916020019161056b565b820191905f5260205f20905b81548152906001019060200180831161054e57829003601f168201915b5050505050905090565b5f33610582818585610aac565b5060019392505050565b5f33610599858285610ab9565b6105a4858585610b2e565b506001949350505050565b5f828152600660205260409020600101546105c981610b8b565b6105d38383610b95565b50505050565b6001600160a01b03811633146106025760405163334bd91960e11b815260040160405180910390fd5b61060c8282610c26565b505050565b7f9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a661063b81610b8b565b610643610c91565b6001600160a01b038516158061066157506001600160a01b03851630145b1561068f57604051630bc2c5df60e11b81526001600160a01b03861660048201526024015b60405180910390fd5b835f036106af5760405163162908e360e11b815260040160405180910390fd5b826106cd5760405163d556c21960e01b815260040160405180910390fd5b5f8381526008602052604090205460ff16156106ff5760405163016f5f7360e21b815260048101849052602401610686565b428267ffffffffffffffff16101561073c57604051634274024760e11b815267ffffffffffffffff83166004820152426024820152604401610686565b6001600160a01b0385165f9081526007602052604081205467ffffffffffffffff169081900361078a576040516330cfbf8f60e01b81526001600160a01b0387166004820152602401610686565b428167ffffffffffffffff1610156107d057604051630a47b38d60e21b81526001600160a01b038716600482015267ffffffffffffffff82166024820152604401610686565b5f6107da60025490565b90507f00000000000000000000000000000000000000000000000000000000000000006108078783611247565b1115610856576040516336a62f1f60e01b815260048101879052602481018290527f00000000000000000000000000000000000000000000000000000000000000006044820152606401610686565b5f858152600860205260409020805460ff191660011790556108788787610cb7565b866001600160a01b0316857fa07df9051bdbcafa9b686a1764ca00a2125ba12e89de80b5045e64cd364c8c41886108ae60025490565b6040805192835260208301919091520160405180910390a350505050505050565b7f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a6108f981610b8b565b610901610cef565b50565b6001600160a01b0381165f9081526007602052604081205467ffffffffffffffff16801580159061093f5750428167ffffffffffffffff1610155b9392505050565b7f65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a61097081610b8b565b610901610d41565b5f9182526006602090815260408084206001600160a01b0393909316845291905290205460ff1690565b6060600480546104f49061120f565b5f33610582818585610b2e565b7f442a94f1a1fac79af32856af2a64f63648cfa2ef3b98610a5bb7cbec4cee69856109e881610b8b565b6001600160a01b038316610a1a57604051630bc2c5df60e11b81526001600160a01b0384166004820152602401610686565b6001600160a01b0383165f81815260076020908152604091829020805467ffffffffffffffff191667ffffffffffffffff871690811790915591519182527f889d4fcf941f62f2ba58151906fdfcf690f9e7c76882c57b70a221cdfbd78d6a910160405180910390a2505050565b5f82815260066020526040902060010154610aa281610b8b565b6105d38383610c26565b61060c8383836001610d7e565b6001600160a01b038381165f908152600160209081526040808320938616835292905220545f1981146105d35781811015610b2057604051637dc7a0d960e11b81526001600160a01b03841660048201526024810182905260448101839052606401610686565b6105d384848484035f610d7e565b6001600160a01b038316610b5757604051634b637e8f60e11b81525f6004820152602401610686565b6001600160a01b038216610b805760405163ec442f0560e01b81525f6004820152602401610686565b61060c838383610e50565b6109018133610ea2565b5f610ba08383610978565b610c1f575f8381526006602090815260408083206001600160a01b03861684529091529020805460ff19166001179055610bd73390565b6001600160a01b0316826001600160a01b0316847f2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d60405160405180910390a45060016104df565b505f6104df565b5f610c318383610978565b15610c1f575f8381526006602090815260408083206001600160a01b0386168085529252808320805460ff1916905551339286917ff6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b9190a45060016104df565b60055460ff1615610cb55760405163d93c066560e01b815260040160405180910390fd5b565b6001600160a01b038216610ce05760405163ec442f0560e01b81525f6004820152602401610686565b610ceb5f8383610e50565b5050565b610cf7610edb565b6005805460ff191690557f5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa335b6040516001600160a01b03909116815260200160405180910390a1565b610d49610c91565b6005805460ff191660011790557f62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258610d243390565b6001600160a01b038416610da75760405163e602df0560e01b81525f6004820152602401610686565b6001600160a01b038316610dd057604051634a1406b160e11b81525f6004820152602401610686565b6001600160a01b038085165f90815260016020908152604080832093871683529290522082905580156105d357826001600160a01b0316846001600160a01b03167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b92584604051610e4291815260200190565b60405180910390a350505050565b6001600160a01b03821615801590610e6e5750610e6c82610904565b155b15610e97576040516330cfbf8f60e01b81526001600160a01b0383166004820152602401610686565b61060c838383610efe565b610eac8282610978565b610ceb5760405163e2517d3f60e01b81526001600160a01b038216600482015260248101839052604401610686565b60055460ff16610cb557604051638dfc202b60e01b815260040160405180910390fd5b610f06610c91565b61060c8383836001600160a01b038316610f36578060025f828254610f2b9190611247565b90915550610fa69050565b6001600160a01b0383165f9081526020819052604090205481811015610f885760405163391434e360e21b81526001600160a01b03851660048201526024810182905260448101839052606401610686565b6001600160a01b0384165f9081526020819052604090209082900390555b6001600160a01b038216610fc257600280548290039055610fe0565b6001600160a01b0382165f9081526020819052604090208054820190555b816001600160a01b0316836001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef8360405161102591815260200190565b60405180910390a3505050565b5f60208284031215611042575f5ffd5b81356001600160e01b03198116811461093f575f5ffd5b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b03811681146110a4575f5ffd5b919050565b5f5f604083850312156110ba575f5ffd5b6110c38361108e565b946020939093013593505050565b5f5f5f606084860312156110e3575f5ffd5b6110ec8461108e565b92506110fa6020850161108e565b929592945050506040919091013590565b5f6020828403121561111b575f5ffd5b5035919050565b5f5f60408385031215611133575f5ffd5b823591506111436020840161108e565b90509250929050565b803567ffffffffffffffff811681146110a4575f5ffd5b5f5f5f5f60808587031215611176575f5ffd5b61117f8561108e565b9350602085013592506040850135915061119b6060860161114c565b905092959194509250565b5f602082840312156111b6575f5ffd5b61093f8261108e565b5f5f604083850312156111d0575f5ffd5b6111d98361108e565b91506111436020840161114c565b5f5f604083850312156111f8575f5ffd5b6112018361108e565b91506111436020840161108e565b600181811c9082168061122357607f821691505b60208210810361124157634e487b7160e01b5f52602260045260245ffd5b50919050565b808201808211156104df57634e487b7160e01b5f52601160045260245ffdfea2646970667358221220bb7a0a3ba938145faaea5432048cf6f19f020b82ec6b46b4ada04f6411bc4bf464736f6c634300081c0033' as `0x${string}`;
