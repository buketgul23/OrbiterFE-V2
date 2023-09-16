import axios from 'axios';
import util from "../util/util";
import BigNumber from "bignumber.js";
import { RequestMethod, requestOpenApi } from "./openApiAx";

const makerSortMap = {};

export async function getMdcRuleLatest(dealerAddress) {
    if (!new RegExp(/^0x[a-fA-F0-9]{40}$/).test(dealerAddress)) {
        return null;
    }
    const thegraphApi = process.env.VUE_APP_THEGRAPH_API;
    if (!thegraphApi) {
        return null;
    }
    const res = await axios.post(thegraphApi, {
        query: `{
        chainRels {
            id
            tokens {
              tokenAddress
              symbol
              name
              decimals
            }
            nativeToken
          }
        dealer(id: "${ dealerAddress.toLowerCase() }") {
            mdcs {
            id
            owner
            mapping {
              chainIdMapping {
                chainId
                chainIdIndex
              }
              dealerMapping {
                dealerAddr
                dealerIndex
              }
              ebcMapping {
                ebcAddr
                ebcIndex
              }
            }
            ruleSnapshot(orderBy: version, orderDirection: desc) {
              version
              ebc {
                id
              }
              ruleLatest{
                id
                chain0
                chain0ResponseTime
                chain0Status
                chain0Token
                chain0TradeFee
                chain0WithholdingFee
                chain0maxPrice
                chain0minPrice
                chain1
                chain0CompensationRatio
                chain1CompensationRatio
                chain1ResponseTime
                chain1Status
                chain1Token
                chain1TradeFee
                chain1WithholdingFee
                chain1maxPrice
                chain1minPrice
                ruleValidation
                enableTimestamp
              }
            }
          }
        }
      }`,
    });
    const response = res.data?.data;
    if (!response?.dealer || !response?.chainRels) return [];
    let updateTime = 0;
    const v3ChainList = await convertV3ChainList(response.chainRels);
    const mdcs = response.dealer.mdcs || [];
    const marketList = [];
    const makerAddressList = [];
    for (const mdc of mdcs) {
        const chainIdMap = {};
        if (!mdc?.mapping?.chainIdMapping?.length) continue;
        for (const chainIdData of mdc.mapping.chainIdMapping) {
            chainIdMap[chainIdData.chainId] = chainIdData.chainIdIndex;
        }
        const ruleSnapshots = mdc.ruleSnapshot.sort(function (a, b) {
            return b.version - a.version;
        });
        const nextUpdateTimeMap = {};
        for (const ruleSnapshot of ruleSnapshots) {
            const ebcId = mdc.mapping.ebcMapping.find(item => item.ebcAddr === ruleSnapshot.ebc.id)?.ebcIndex;
            if (!ebcId) {
                continue;
            }
            const rules = ruleSnapshot?.ruleLatest;
            if (!rules) continue;
            for (const rule of rules) {
                const fromId = rule.chain0 + rule.chain0Token + rule.chain1 + rule.chain1Token + mdc.owner;
                const toId = rule.chain1 + rule.chain1Token + rule.chain0 + rule.chain0Token + mdc.owner;
                const enableTimestamp = +rule.enableTimestamp * 1000;
                if (enableTimestamp > new Date().valueOf()) {
                    if (!updateTime) updateTime = enableTimestamp;
                    updateTime = Math.min(updateTime, enableTimestamp);
                    nextUpdateTimeMap[fromId] = nextUpdateTimeMap[fromId] || 0;
                    nextUpdateTimeMap[toId] = nextUpdateTimeMap[toId] || 0;
                    nextUpdateTimeMap[fromId] = Math.min(nextUpdateTimeMap[fromId], enableTimestamp);
                    nextUpdateTimeMap[toId] = Math.min(nextUpdateTimeMap[toId], enableTimestamp);
                    continue;
                }
                if (!rule.ruleValidation) {
                    continue;
                }
                const dealerId = mdc.mapping.dealerMapping.find(item => item.dealerAddr.toLowerCase() === dealerAddress.toLowerCase())?.dealerIndex;
                const token0 = getTokenByTokenAddress(v3ChainList, String(rule.chain0), rule.chain0Token);
                const token1 = getTokenByTokenAddress(v3ChainList, String(rule.chain1), rule.chain1Token);
                const chainInfo0 = v3ChainList.find(item => item.chainId === String(rule.chain0));
                const chainInfo1 = v3ChainList.find(item => item.chainId === String(rule.chain1));
                if (!token0 || !token1 || !chainInfo0 || !chainInfo1) {
                    continue;
                }
                if (rule.chain0Status) {
                    const maxPrice = floor(Number(new BigNumber(rule.chain0maxPrice).dividedBy(10 ** token0.decimals)), token0.decimals);
                    const minPrice = ceil(Number(new BigNumber(rule.chain0minPrice).dividedBy(10 ** token0.decimals)), token0.decimals);
                    if (new BigNumber(maxPrice).gte(minPrice) &&
                        rule.chain0WithholdingFee.substr(rule.chain0WithholdingFee.length - 4, 4) === '0000' &&
                        !marketList.find(item => item.id === fromId)) {
                        const makerAddress = mdc.owner.toLowerCase();
                        makerAddressList.push(makerAddress);
                        marketList.push({
                            version: ruleSnapshot.version,
                            ruleId: rule.id,
                            pairId: `${ rule.chain0 }-${ rule.chain1 }:${ token0.symbol }-${ token1.symbol }`,
                            id: fromId,
                            dealerId,
                            ebcId,
                            ebcAddress: ruleSnapshot.ebc.id,
                            recipient: makerAddress,
                            sender: makerAddress,
                            spentTime: rule.chain0ResponseTime,
                            status: rule.chain0Status,
                            compensationRatio: rule.chain0CompensationRatio,
                            fromChain: {
                                id: chainIdMap[rule.chain0],
                                networkId: rule.chain0,
                                chainId: rule.chain0,
                                name: chainInfo0.name,
                                symbol: token0.symbol,
                                tokenAddress: token0.address,
                                decimals: token0.decimals,
                                maxPrice,
                                minPrice,
                                originMaxPrice: rule.chain0maxPrice,
                                originMinPrice: rule.chain0minPrice,
                            },
                            toChain: {
                                id: chainIdMap[rule.chain1],
                                networkId: rule.chain1,
                                chainId: rule.chain1,
                                name: chainInfo1.name,
                                symbol: token1.symbol,
                                tokenAddress: token1.address,
                                decimals: token1.decimals,
                            },
                            gasFee: new BigNumber(rule.chain0TradeFee).dividedBy(1000).toFixed(6),
                            tradingFee: new BigNumber(rule.chain0WithholdingFee).dividedBy(10 ** token0.decimals).toFixed(),
                            originTradeFee: rule.chain0TradeFee,
                            originWithholdingFee: rule.chain0WithholdingFee,
                            nextUpdateTime: nextUpdateTimeMap[fromId] || 0,
                        });
                    }
                }
                if (rule.chain1Status) {
                    const maxPrice = floor(Number(new BigNumber(rule.chain1maxPrice).dividedBy(10 ** token1.decimals)), token1.decimals);
                    const minPrice = ceil(Number(new BigNumber(rule.chain1minPrice).dividedBy(10 ** token1.decimals)), token1.decimals);
                    if (new BigNumber(maxPrice).gte(minPrice) &&
                        rule.chain1WithholdingFee.substr(rule.chain1WithholdingFee.length - 4, 4) === '0000' &&
                        !marketList.find(item => item.id === toId)) {
                        const makerAddress = mdc.owner.toLowerCase();
                        makerAddressList.push(makerAddress);
                        marketList.push({
                            version: ruleSnapshot.version,
                            ruleId: rule.id,
                            pairId: `${ rule.chain1 }-${ rule.chain0 }:${ token1.symbol }-${ token0.symbol }`,
                            id: toId,
                            dealerId,
                            ebcId,
                            ebcAddress: ruleSnapshot.ebc.id,
                            recipient: makerAddress,
                            sender: makerAddress,
                            spentTime: rule.chain1ResponseTime,
                            status: rule.chain1Status,
                            compensationRatio: rule.chain1CompensationRatio,
                            fromChain: {
                                id: Number(chainIdMap[rule.chain1]),
                                networkId: rule.chain1,
                                chainId: rule.chain1,
                                name: chainInfo1.name,
                                symbol: token1.symbol,
                                tokenAddress: token1.address,
                                decimals: token1.decimals,
                                maxPrice,
                                minPrice,
                                originMaxPrice: rule.chain1maxPrice,
                                originMinPrice: rule.chain1minPrice,
                            },
                            toChain: {
                                id: Number(chainIdMap[rule.chain0]),
                                networkId: rule.chain0,
                                chainId: rule.chain0,
                                name: chainInfo0.name,
                                symbol: token0.symbol,
                                tokenAddress: token0.address,
                                decimals: token0.decimals,
                            },
                            gasFee: new BigNumber(rule.chain1TradeFee).dividedBy(1000).toFixed(6),
                            tradingFee: new BigNumber(rule.chain1WithholdingFee).dividedBy(10 ** token1.decimals).toFixed(),
                            originTradeFee: rule.chain1TradeFee,
                            originWithholdingFee: rule.chain1WithholdingFee,
                            nextUpdateTime: nextUpdateTimeMap[toId] || 0,
                        });
                    }
                }
            }
        }
    }
    updateTime = Math.min(updateTime, new Date().valueOf() + 30 * 1000);
    updateTime = Math.max(updateTime, 0);
    const symbolSortMap = { "ETH": 1, "USDC": 2, "USDT": 3, "DAI": 4 };
    if (!Object.keys(makerSortMap).length) {
        Array.from(new Set(makerAddressList)).sort(function () {
            return 0.5 - Math.random();
        }).forEach((makerAddress, index) => {
            makerSortMap[makerAddress] = index;
        });
    }
    const ruleList = marketList.sort(function (a, b) {
        if (a.fromChain.id !== b.fromChain.id) {
            return a.fromChain.id - b.fromChain.id;
        }
        if (symbolSortMap[a.fromChain.symbol] !== symbolSortMap[b.fromChain.symbol]) {
            return symbolSortMap[a.fromChain.symbol] - symbolSortMap[b.fromChain.symbol];
        }
        if (makerSortMap[a.recipient] !== makerSortMap[b.recipient]) {
            return makerSortMap[a.recipient] - makerSortMap[b.recipient];
        }
        return a.recipient - b.recipient;
    });
    util.log('makerOrder', makerSortMap);
    util.log('ruleList', ruleList);
    return { ruleList, updateTime };
}

async function convertV3ChainList(chainRels) {
    const chainList = (await requestOpenApi(RequestMethod.chainList)) || [];
    const v3ChainList = [];
    for (const chain of chainRels) {
        const v3Tokens = chain.tokens;
        if (!chain.id || !v3Tokens?.length) continue;
        const v3ChainInfo = chainList.find(item => item.chainId === chain.id);
        if (!v3ChainInfo) continue;
        const newV3ChainInfo = JSON.parse(JSON.stringify(v3ChainInfo));
        if (chain.nativeToken.toLowerCase() !== util.starknetHashFormat(newV3ChainInfo.nativeCurrency.address)) {
            newV3ChainInfo.nativeCurrency = {};
        }
        for (const token of v3Tokens) {
            token.address = token.tokenAddress = "0x" + token.tokenAddress.substr(26);
            if (token.symbol.indexOf("USDC") !== -1) {
                token.symbol = "USDC";
            }
            if (token.symbol.indexOf("USDT") !== -1) {
                token.symbol = "USDT";
            }
            if (token.symbol.indexOf("DAI") !== -1) {
                token.symbol = "DAI";
            }
        }
        newV3ChainInfo.tokens = v3Tokens;
        v3ChainList.push(newV3ChainInfo);
    }
    return v3ChainList;
}

function getTokenByTokenAddress(v3ChainList, chainId, tokenAddress) {
    const chainInfo = v3ChainList.find(item => item.chainId === String(chainId));
    if (!chainInfo) return null;
    const tokenList = getChainTokenList(chainInfo);
    return tokenList.find(item => util.starknetHashFormat(item.address).toLowerCase() === tokenAddress.toLowerCase());
}

function getChainTokenList(chain) {
    const allTokenList = [];
    if (!chain) return [];
    if (chain.tokens && chain.tokens.length) {
        allTokenList.push(...chain.tokens);
    }
    if (chain.nativeCurrency) {
        allTokenList.push(chain.nativeCurrency);
    }
    return allTokenList;
}

function ceil(n, decimals = 6) {
    const fix = Math.min(decimals - 4, 6);
    return Number(new BigNumber(Math.ceil(n * 10 ** fix)).dividedBy(10 ** fix));
}

function floor(n, decimals = 6) {
    const fix = Math.min(decimals - 4, 6);
    return Number(new BigNumber(Math.floor(n * 10 ** fix)).dividedBy(10 ** fix));
}